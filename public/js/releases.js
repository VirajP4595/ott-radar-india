// Builds the release list for a month from TMDB (with the user's token) plus the
// owner's manual entries from /api/manual.
import { cacheGet, cacheSet, cacheRemovePrefix } from './store.js';
import { pool } from './tmdb.js';
import { PLATFORMS, keyForText, keysInText, idsForKeys } from './platforms.js';
import * as D from './dates.js';

const H = 3600e3;
const MAX_MOVIE_PAGES = 5;
const MAX_TV_PAGES = 4;

function pickIN(wp) {
  const r = wp?.results?.IN;
  if (!r) return { link: '', p: [] };
  const p = [...(r.flatrate || []), ...(r.free || []), ...(r.ads || [])].map((x) => [x.provider_id, x.provider_name]);
  return { link: r.link || '', p };
}
function providerKeys(pin, map) {
  const set = new Set();
  for (const [id, name] of pin.p || []) {
    const k = map.ids[id] || keyForText(name);
    if (k) set.add(k);
  }
  return [...set];
}

async function discoverIds(tmdb, path, params, maxPages) {
  const first = await tmdb.get(path, { ...params, page: 1 });
  const pages = Math.min(first.total_pages || 1, maxPages);
  const rest = await pool(
    Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2),
    3,
    (page) => tmdb.get(path, { ...params, page }),
  );
  const seen = new Set();
  const ids = [];
  for (const r of [first, ...rest]) {
    for (const x of r?.results || []) {
      if (!seen.has(x.id)) { seen.add(x.id); ids.push(x.id); }
    }
  }
  return ids;
}

// ---------- Movies
async function movieInfo(tmdb, id) {
  const ck = `m:${id}`;
  const c = cacheGet(ck);
  if (c) return c;
  const d = await tmdb.get(`/movie/${id}`, { append_to_response: 'watch/providers,release_dates' });
  const inRel = (d.release_dates?.results || []).find((r) => r.iso_3166_1 === 'IN');
  const v = {
    id: d.id,
    title: d.title || d.original_title || 'Untitled',
    lang: d.original_language || '',
    poster: d.poster_path || '',
    runtime: d.runtime || 0,
    genres: (d.genres || []).map((g) => g.name).slice(0, 3),
    digital: (inRel?.release_dates || [])
      .filter((r) => r.type === 4)
      .map((r) => ({ date: String(r.release_date || '').slice(0, 10), note: r.note || '' })),
    wp: pickIN(d['watch/providers']),
  };
  cacheSet(ck, v, 24 * H);
  return v;
}

async function movieRelease(tmdb, map, id, from, to) {
  const m = await movieInfo(tmdb, id);
  const hit = m.digital.filter((x) => x.date >= from && x.date <= to).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  if (!hit) return null;
  const platforms = [...new Set([...providerKeys(m.wp, map), ...keysInText(hit.note)])];
  if (!platforms.length) return null; // not on a platform we track
  return {
    id: `movie:${m.id}:${hit.date}`, key: `movie:${m.id}`, mediaType: 'movie', tmdbId: m.id,
    title: m.title, lang: m.lang, date: hit.date, platforms, kind: 'movie', label: '',
    poster: m.poster, runtime: m.runtime, genres: m.genres, status: 'Confirmed', source: 'TMDB',
  };
}

// ---------- Series
async function tvInfo(tmdb, id) {
  const ck = `t:${id}`;
  const c = cacheGet(ck);
  if (c) return c;
  const d = await tmdb.get(`/tv/${id}`, { append_to_response: 'watch/providers' });
  const seasons = [d.last_episode_to_air?.season_number, d.next_episode_to_air?.season_number]
    .filter((n) => Number.isInteger(n) && n > 0);
  const v = {
    id: d.id,
    title: d.name || d.original_name || 'Untitled',
    lang: d.original_language || '',
    poster: d.poster_path || '',
    runtime: (d.episode_run_time || [])[0] || 0,
    genres: (d.genres || []).map((g) => g.name).slice(0, 3),
    seasons: [...new Set(seasons)],
    wp: pickIN(d['watch/providers']),
  };
  cacheSet(ck, v, 12 * H);
  return v;
}

async function seasonEpisodes(tmdb, id, n) {
  const ck = `s2:${id}:${n}`;
  const c = cacheGet(ck);
  if (c) return c;
  const d = await tmdb.get(`/tv/${id}/season/${n}`);
  const v = (d.episodes || [])
    .filter((e) => e.air_date)
    .map((e) => ({ s: e.season_number, e: e.episode_number, date: e.air_date, type: e.episode_type || '' }));
  cacheSet(ck, v, 12 * H);
  return v;
}

function tvLabel(eps) {
  const f = eps[0];
  const l = eps[eps.length - 1];
  const count = eps.length > 1 ? ` · ${eps.length} episodes` : '';
  // TMDB marks episodes as "finale" (season/series) or "mid_season" (mid-season finale).
  const fin = eps.find((e) => e.type === 'finale') ? 'finale' : eps.find((e) => e.type === 'mid_season') ? 'mid_season' : '';
  const finText = fin === 'finale' ? ' · Finale' : fin === 'mid_season' ? ' · Mid-season finale' : '';
  if (f.s === 1 && f.e === 1) return { kind: 'series', label: `New series${count}`, finale: fin };
  if (f.e === 1) return { kind: 'season', label: `Season ${f.s}${count}`, finale: fin };
  return { kind: 'episode', label: (eps.length > 1 ? `S${f.s} E${f.e}–${l.e}` : `S${f.s} E${f.e}`) + finText, finale: fin };
}

async function tvReleases(tmdb, map, id, from, to) {
  const t = await tvInfo(tmdb, id);
  const platforms = providerKeys(t.wp, map);
  if (!platforms.length) return [];
  const eps = (await Promise.all(t.seasons.map((n) => seasonEpisodes(tmdb, id, n)))).flat()
    .filter((e) => e.date >= from && e.date <= to);
  const byDate = new Map();
  for (const e of eps) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  return [...byDate.entries()].map(([date, list]) => {
    list.sort((a, b) => a.s - b.s || a.e - b.e);
    const { kind, label, finale } = tvLabel(list);
    return {
      id: `tv:${t.id}:${date}`, key: `tv:${t.id}`, mediaType: 'tv', tmdbId: t.id,
      title: t.title, lang: t.lang, date, platforms, kind, label, finale,
      poster: t.poster, runtime: t.runtime, genres: t.genres, status: 'Confirmed', source: 'TMDB',
    };
  });
}

/** All TMDB releases in India for month "YYYY-MM" on tracked platforms. Cached on the device. */
export async function loadMonth(tmdb, map, mk, onProgress) {
  const ck = `rel2:${mk}`;
  const c = cacheGet(ck);
  if (c) return c;
  const from = D.monthStart(mk);
  const to = D.monthEnd(mk);
  const providerIds = idsForKeys(map, PLATFORMS.map((p) => p.key));

  const [movieIds, tvIds] = await Promise.all([
    discoverIds(tmdb, '/discover/movie', {
      region: 'IN', with_release_type: 4, 'release_date.gte': from, 'release_date.lte': to,
      sort_by: 'popularity.desc', include_adult: false,
    }, MAX_MOVIE_PAGES),
    providerIds.length
      ? discoverIds(tmdb, '/discover/tv', {
        watch_region: 'IN', with_watch_providers: providerIds.join('|'),
        with_watch_monetization_types: 'flatrate|free|ads',
        'air_date.gte': from, 'air_date.lte': to, sort_by: 'popularity.desc', include_adult: false,
      }, MAX_TV_PAGES)
      : [],
  ]);

  const total = movieIds.length + tvIds.length;
  let done = 0;
  const tick = () => onProgress?.(++done, total);
  onProgress?.(0, total);

  const [movies, shows] = await Promise.all([
    pool(movieIds, 6, async (id) => { const r = await movieRelease(tmdb, map, id, from, to); tick(); return r; }),
    pool(tvIds, 4, async (id) => { const r = await tvReleases(tmdb, map, id, from, to); tick(); return r; }),
  ]);
  const list = [];
  movies.forEach((r, i) => { if (r) list.push({ ...r, rank: i }); });
  shows.forEach((rs, i) => { for (const r of rs || []) list.push({ ...r, rank: i + 0.5 }); });

  cacheSet(ck, list, to < D.today() ? 7 * 24 * H : 6 * H);
  return list;
}

// ---------- Manual entries (owner adds these; stored in Cloudflare D1)
function manualToRelease(m) {
  const tv = m.media_type === 'tv';
  const label = m.label || '';
  return {
    id: `manual:${m.id}`, manualId: m.id,
    key: m.tmdb_id ? `${m.media_type}:${m.tmdb_id}` : `manual:${m.id}`,
    mediaType: tv ? 'tv' : 'movie', tmdbId: m.tmdb_id || null,
    title: m.title, lang: m.original_language || '', date: m.date, platforms: [m.platform],
    kind: tv ? (/^s\d+\s*e\d+/i.test(label) ? 'episode' : label ? 'season' : 'series') : 'movie',
    label, finale: /mid-?season finale/i.test(label) ? 'mid_season' : /finale/i.test(label) ? 'finale' : '',
    poster: m.poster_path || '', runtime: 0, genres: [],
    status: m.status === 'Confirmed' ? 'Confirmed' : 'Expected', source: 'Manual',
    sourceUrl: m.source_url || '', rank: -1,
  };
}

export async function fetchManual(from, to) {
  const ck = `man:${from}:${to}`;
  const c = cacheGet(ck);
  if (c) return c;
  try {
    const res = await fetch(`/api/manual?from=${from}&to=${to}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const j = await res.json();
    const list = (j.entries || []).map(manualToRelease);
    cacheSet(ck, list, 10 * 60e3);
    return list;
  } catch {
    return []; // offline, or running without the Cloudflare function
  }
}
export const clearManualCache = () => cacheRemovePrefix('man:');

/** Manual entries win over TMDB. A different TMDB date is kept as `conflict` so the UI can flag it. */
export function mergeReleases(tmdbList, manual) {
  const byKey = new Map();
  for (const r of tmdbList) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const drop = new Set();
  const extra = [];
  for (const m0 of manual) {
    const m = { ...m0 };
    const t = byKey.get(m.key) || [];
    if (t.length) {
      const same = t.find((x) => x.date === m.date);
      const ref = same || t[0];
      m.lang = m.lang || ref.lang;
      m.genres = ref.genres;
      m.runtime = ref.runtime;
      m.poster = m.poster || ref.poster;
      m.rank = ref.rank;
      if (same) drop.add(same);
      else if (m.mediaType === 'movie') {
        m.conflict = ref.date;
        t.forEach((x) => drop.add(x));
      }
    }
    extra.push(m);
  }
  return [...tmdbList.filter((r) => !drop.has(r)), ...extra]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.rank ?? 0) - (b.rank ?? 0)));
}

/**
 * kind: all | premieres (new series + season premieres) | movies | finales.
 * mine: only titles in the watchlist (their ordinary episodes included).
 * In "all", ordinary episodes are hidden unless f.episodes is on; finales always show.
 */
export function applyFilters(list, f, watchKeys = new Set()) {
  return list.filter((r) => {
    if (f.mine && !watchKeys.has(r.key)) return false;
    if (f.platforms.length && !r.platforms.some((p) => f.platforms.includes(p))) return false;
    if (f.languages.length && !f.languages.includes(r.lang)) return false;
    if (f.confirmedOnly && r.status !== 'Confirmed') return false;
    switch (f.kind) {
      case 'premieres': return r.kind === 'series' || r.kind === 'season';
      case 'movies': return r.mediaType === 'movie';
      case 'finales': return !!r.finale;
      default: return f.mine || f.episodes || r.kind !== 'episode' || !!r.finale;
    }
  });
}
