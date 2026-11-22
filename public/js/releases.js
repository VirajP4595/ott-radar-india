// Builds the release list for a month from TMDB (with the user's token) plus the
// owner's manual entries from /api/manual.
import { cacheGet, cacheSet, cacheRemovePrefix } from './store.js';
import { pool } from './tmdb.js';
import { PLATFORMS, keyForText, keysInText, idsForKeys, platformByKey } from './platforms.js';
import * as D from './dates.js';
import { langsInText, uniq } from './ui.js';

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
  const ck = `m3:${id}`;
  const c = cacheGet(ck);
  if (c) return c;
  const d = await tmdb.get(`/movie/${id}`, { append_to_response: 'watch/providers,release_dates' });
  const inRel = (d.release_dates?.results || []).find((r) => r.iso_3166_1 === 'IN');
  const v = {
    id: d.id,
    title: d.title || d.original_title || 'Untitled',
    lang: d.original_language || '',
    langs: uniq([d.original_language, ...(d.spoken_languages || []).map((l) => l.iso_639_1)]),
    poster: d.poster_path || '',
    runtime: d.runtime || 0,
    genres: (d.genres || []).map((g) => g.name).slice(0, 3),
    released: String(d.release_date || '').slice(0, 10),
    pop: d.popularity || 0,
    votes: d.vote_count || 0,
    digital: (inRel?.release_dates || [])
      .filter((r) => r.type === 4)
      .map((r) => ({ date: String(r.release_date || '').slice(0, 10), note: r.note || '' })),
    // Digital dates in other countries whose note names a service (e.g. Brazil: "Netflix").
    // Used only when India has no digital date at all.
    otherDigital: (d.release_dates?.results || [])
      .filter((c) => c.iso_3166_1 !== 'IN')
      .flatMap((c) => (c.release_dates || [])
        .filter((r) => r.type === 4 && keysInText(r.note || '').length)
        .map((r) => ({ date: String(r.release_date || '').slice(0, 10), cc: c.iso_3166_1, note: r.note })))
      .slice(0, 40),
    wp: pickIN(d['watch/providers']),
  };
  cacheSet(ck, v, 24 * H);
  return v;
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

async function movieRelease(tmdb, map, id, from, to) {
  const m = await movieInfo(tmdb, id);
  const inKeys = providerKeys(m.wp, map);
  const make = (date, platforms, status, extra = {}) => ({
    id: `movie:${m.id}:${date}`, key: `movie:${m.id}`, mediaType: 'movie', tmdbId: m.id,
    title: m.title, lang: m.lang, langs: uniq([m.lang, ...(m.langs || []), ...(extra.noteLangs || [])]),
    date, platforms, kind: 'movie', label: '',
    poster: m.poster, runtime: m.runtime, genres: m.genres, status, source: 'TMDB', dateFrom: extra.dateFrom || '',
  });

  // 1) India digital date: the authoritative case.
  const hit = m.digital.filter((x) => x.date >= from && x.date <= to).sort(byDate)[0];
  if (hit) {
    const platforms = uniq([...inKeys, ...keysInText(hit.note)]);
    if (platforms.length) return make(hit.date, platforms, 'Confirmed', { noteLangs: langsInText(hit.note) });
    // No service named anywhere and none listed for India: show it as "Platform TBA" rather than
    // dropping it, but only for real feature films (TMDB also lists shorts and test entries).
    // If India lists only services we don't track, it really isn't ours.
    const feature = (m.runtime >= 60 || (!m.runtime && m.pop >= 0.8)) && m.pop >= 0.4;
    if (!(m.wp.p || []).length && m.poster && feature) return make(hit.date, ['unknown'], 'Confirmed', { noteLangs: langsInText(hit.note) });
    return null;
  }
  if (m.digital.length) return null; // India has a digital date, just not in this range

  // 2) No India digital date at all: borrow another country's date, but only when that
  //    country's note names a service the title is on in India (worldwide originals, or an
  //    older film arriving on that service). Shown as "Likely date".
  //    Films over a year old must show the same service + date in at least 3 countries, so a
  //    single country's catalogue change (e.g. an old film added to Netflix Philippines) doesn't count.
  if (!inKeys.length) return null;
  const old = !m.released || m.released < D.addDays(from, -365);
  const groups = new Map(); // "date|service" -> countries
  for (const x of m.otherDigital || []) {
    if (x.date < from || x.date > to) continue;
    for (const k of keysInText(x.note)) {
      if (!inKeys.includes(k)) continue;
      const g = `${x.date}|${k}`;
      if (!groups.has(g)) groups.set(g, new Set());
      groups.get(g).add(x.cc);
    }
  }
  const ok = [...groups.entries()]
    .filter(([, ccs]) => ccs.size >= (old ? 3 : 1))
    .map(([g, ccs]) => ({ date: g.split('|')[0], key: g.split('|')[1], cc: [...ccs][0], n: ccs.size }))
    .sort((a, b) => byDate(a, b) || b.n - a.n);
  if (!ok.length) return null;
  const date = ok[0].date;
  const platforms = uniq(ok.filter((x) => x.date === date).map((x) => x.key));
  return make(date, platforms, 'Likely', { dateFrom: ok[0].cc });
}

// ---------- Series
async function tvInfo(tmdb, id) {
  const ck = `t2:${id}`;
  const c = cacheGet(ck);
  if (c) return c;
  const d = await tmdb.get(`/tv/${id}`, { append_to_response: 'watch/providers' });
  const seasons = [d.last_episode_to_air?.season_number, d.next_episode_to_air?.season_number]
    .filter((n) => Number.isInteger(n) && n > 0);
  const v = {
    id: d.id,
    title: d.name || d.original_name || 'Untitled',
    lang: d.original_language || '',
    langs: uniq([d.original_language, ...(d.languages || []), ...(d.spoken_languages || []).map((l) => l.iso_639_1)]),
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
      title: t.title, lang: t.lang, langs: t.langs || [t.lang], date, platforms, kind, label, finale,
      poster: t.poster, runtime: t.runtime, genres: t.genres, status: 'Confirmed', source: 'TMDB',
    };
  });
}

/** All TMDB releases in India for month "YYYY-MM" on tracked platforms. Cached on the device. */
export async function loadMonth(tmdb, map, mk, onProgress) {
  const ck = `rel5:${mk}`;
  const c = cacheGet(ck);
  if (c) return c;
  const from = D.monthStart(mk);
  const to = D.monthEnd(mk);
  const providerIds = idsForKeys(map, PLATFORMS.map((p) => p.key));

  const [inMovieIds, globalMovieIds, tvIds] = await Promise.all([
    // Movies with an India digital release in the month.
    discoverIds(tmdb, '/discover/movie', {
      region: 'IN', with_release_type: 4, 'release_date.gte': from, 'release_date.lte': to,
      sort_by: 'popularity.desc', include_adult: false,
    }, MAX_MOVIE_PAGES),
    // Movies streaming in India on tracked services with a digital release anywhere that month
    // (catches worldwide originals that have no India date on TMDB).
    providerIds.length
      ? discoverIds(tmdb, '/discover/movie', {
        watch_region: 'IN', with_watch_providers: providerIds.join('|'),
        with_watch_monetization_types: 'flatrate|free|ads', with_release_type: 4,
        'release_date.gte': from, 'release_date.lte': to, sort_by: 'popularity.desc', include_adult: false,
      }, MAX_MOVIE_PAGES)
      : [],
    providerIds.length
      ? discoverIds(tmdb, '/discover/tv', {
        watch_region: 'IN', with_watch_providers: providerIds.join('|'),
        with_watch_monetization_types: 'flatrate|free|ads',
        'air_date.gte': from, 'air_date.lte': to, sort_by: 'popularity.desc', include_adult: false,
      }, MAX_TV_PAGES)
      : [],
  ]);
  const movieIds = uniq([...inMovieIds, ...globalMovieIds]);

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
    title: m.title, lang: m.original_language || '',
    langs: uniq([m.original_language, ...String(m.languages || '').split(',')]),
    date: m.date, platforms: [m.platform],
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

// ---------- Extra sources synced daily on the server (Movie of the Night India, Watchmode)
const splitLangs = (s) => String(s || '').split(',').filter((x) => /^[a-z]{2}$/.test(x));
function extToRelease(row) {
  const motn = row.source === 'motn';
  const tv = row.media_type === 'tv';
  return {
    id: `ext:${row.source}:${row.media_type}:${row.tmdb_id}:${row.date}`,
    key: `${row.media_type}:${row.tmdb_id}`, mediaType: tv ? 'tv' : 'movie', tmdbId: row.tmdb_id,
    title: row.title || 'Untitled', lang: '', langs: splitLangs(row.languages), date: row.date,
    platforms: [row.platform], kind: tv ? 'series' : 'movie',
    label: tv ? `New on ${platformByKey(row.platform)?.name || 'streaming'}` : '',
    poster: '', posterUrl: row.poster_url || '', runtime: 0, genres: [],
    status: motn ? 'Confirmed' : 'Likely', source: motn ? 'Streaming Availability' : 'Watchmode',
    dateFrom: motn ? '' : 'US', link: row.link || '', ext: true, rank: 500,
  };
}

/** Shared rows from the site (uploaded by the owner) + rows this browser fetched with its own keys. */
export async function fetchExternal(from, to, localRows = []) {
  const ck = `ext:${from}:${to}`;
  let shared = cacheGet(ck);
  if (!shared) {
    try {
      const res = await fetch(`/api/external?from=${from}&to=${to}`, { headers: { accept: 'application/json' } });
      shared = res.ok ? (await res.json()).entries || [] : [];
      cacheSet(ck, shared, 30 * 60e3);
    } catch {
      shared = [];
    }
  }
  const pk = (r) => `${r.source}|${r.media_type}|${r.tmdb_id}|${r.platform}`;
  const rows = new Map(shared.map((r) => [pk(r), r]));
  for (const r of localRows) if (r.date >= from && r.date <= to) rows.set(pk(r), r); // this device's own fetch wins
  return [...rows.values()].map(extToRelease);
}

/**
 * Fold the extra sources into the TMDB list, without duplicates:
 *  1. Extra-source rows for one title collapse first. Movie of the Night (India) replaces Watchmode (US);
 *     rows for the same title and day become one entry listing every service.
 *  2. Against TMDB:
 *     - TMDB India date with a known service, same day  -> one entry; services and audio languages are combined.
 *     - same service on a different day                  -> TMDB's India date is kept (a disagreement, not a new release).
 *     - a different service on a different day            -> a separate release (e.g. Prime first, Netflix later).
 *     - TMDB had only "Platform TBA" or a borrowed date   -> replaced by the extra source.
 *     - TMDB doesn't have the title in this range         -> the extra source adds it.
 */
function mergeExternal(tmdbList, ext) {
  const grouped = new Map();
  for (const e of ext) {
    if (!grouped.has(e.key)) grouped.set(e.key, []);
    grouped.get(e.key).push(e);
  }
  const collapsed = [];
  for (const rows of grouped.values()) {
    const india = rows.filter((r) => r.source !== 'Watchmode');
    const byDay = new Map();
    for (const r of india.length ? india : rows) {
      const cur = byDay.get(r.date);
      if (!cur) { byDay.set(r.date, { ...r, platforms: [...r.platforms], langs: [...r.langs] }); continue; }
      cur.platforms = uniq([...cur.platforms, ...r.platforms]);
      cur.langs = uniq([...cur.langs, ...r.langs]);
      cur.link = cur.link || r.link;
      cur.posterUrl = cur.posterUrl || r.posterUrl;
    }
    collapsed.push(...byDay.values());
  }

  const byKey = new Map();
  for (const r of tmdbList) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const fromRef = (e, ref, platforms = e.platforms) => ({
    ...e, platforms, lang: ref.lang, langs: uniq([ref.lang, ...(ref.langs || []), ...e.langs]), poster: ref.poster,
    genres: ref.genres, runtime: ref.runtime, rank: ref.rank, enriched: true,
  });
  const drop = new Set();
  const add = [];
  for (const e of collapsed) {
    const t = byKey.get(e.key) || [];
    const strong = t.filter((x) => x.status === 'Confirmed' && !x.platforms.includes('unknown'));
    if (strong.length) {
      const same = strong.find((x) => x.date === e.date);
      if (same) {
        same.platforms = uniq([...same.platforms, ...e.platforms]);
        same.langs = uniq([...(same.langs || []), ...e.langs]);
        same.link = same.link || e.link;
        continue;
      }
      strong.forEach((x) => { x.langs = uniq([...(x.langs || []), ...e.langs]); });
      const otherServices = e.platforms.filter((p) => !strong.some((x) => x.platforms.includes(p)));
      if (e.source !== 'Watchmode' && otherServices.length) add.push(fromRef(e, strong[0], otherServices));
      continue;
    }
    if (e.source === 'Watchmode' && t.some((x) => x.status === 'Likely')) continue;
    const ref = t[0];
    if (ref) {
      t.forEach((x) => drop.add(x));
      add.push(fromRef(e, ref));
    } else add.push({ ...e });
  }
  return [...tmdbList.filter((x) => !drop.has(x)), ...add];
}

/** Titles that came only from an extra source get poster, language and genres from TMDB. */
export async function enrichExternal(tmdb, list) {
  const todo = list.filter((r) => r.ext && !r.enriched && r.tmdbId);
  await pool(todo, 4, async (r) => {
    const info = r.mediaType === 'movie' ? await movieInfo(tmdb, r.tmdbId) : await tvInfo(tmdb, r.tmdbId);
    Object.assign(r, {
      poster: info.poster || '', lang: info.lang, langs: uniq([info.lang, ...(info.langs || []), ...r.langs]),
      genres: info.genres || [], runtime: info.runtime || 0, enriched: true,
    });
  }).catch(() => {});
  return list;
}

/** Manual entries win over TMDB. A different TMDB date is kept as `conflict` so the UI can flag it. */
export function mergeReleases(tmdbList0, manual, ext = []) {
  const tmdbList = mergeExternal(tmdbList0, ext);
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
      m.langs = uniq([...(m.langs || []), ...(ref.langs || [])]);
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
 * myPlatforms / myLanguages: the user's choices from Settings; anything else is never shown.
 * Titles whose platform is unknown ("Platform TBA") pass the services choice unless f.showUnknown is false.
 * In "all", ordinary episodes are hidden unless f.episodes is on; finales always show.
 */
export function applyFilters(list, f, watchKeys = new Set(), myPlatforms = [], myLanguages = []) {
  return list.filter((r) => {
    // A title matches a language if it is in ANY of its known languages
    // (original, spoken, named in the India release note, or ticked on a manual entry).
    // Unknown language (an extra-source title not yet matched on TMDB) never hides a release.
    const langs = r.langs && r.langs.length ? r.langs : r.lang ? [r.lang] : [];
    const unknown = r.platforms.includes('unknown');
    if (unknown && f.showUnknown === false) return false;
    if (myPlatforms.length && !unknown && !r.platforms.some((p) => myPlatforms.includes(p))) return false;
    if (myLanguages.length && langs.length && !langs.some((l) => myLanguages.includes(l))) return false;
    if (f.mine && !watchKeys.has(r.key)) return false;
    if (f.platforms.length && !r.platforms.some((p) => f.platforms.includes(p))) return false;
    if (f.languages.length && langs.length && !langs.some((l) => f.languages.includes(l))) return false;
    if (f.confirmedOnly && r.status !== 'Confirmed') return false;
    switch (f.kind) {
      case 'premieres': return r.kind === 'series' || r.kind === 'season';
      case 'movies': return r.mediaType === 'movie';
      case 'finales': return !!r.finale;
      default: return f.mine || f.episodes || r.kind !== 'episode' || !!r.finale;
    }
  });
}
