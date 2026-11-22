// Extra release sources fetched in the BROWSER with keys the user saved in Settings
// (like the TMDB token): keys are stored only on this device and sent only to these APIs.
//  - Movie of the Night "Streaming Availability" (India): announced (upcoming) and newly added titles
//    on Netflix, Prime Video, JioHotstar, ZEE5, SonyLIV and Apple TV+, with audio languages.
//  - Watchmode (free plan, US data): release dates of streaming originals ("Likely date").

const MOTN_BASE = 'https://api.movieofthenight.com/v4';
const WATCHMODE_BASE = 'https://api.watchmode.com/v1';
const MOTN_SERVICES = { netflix: 'netflix', prime: 'prime', hotstar: 'jiohotstar', zee5: 'zee5', sonyliv: 'sonyliv', apple: 'appletv' };
// One request per service: all six in one request takes ~2 minutes on their side; one takes seconds.
// Pages per refresh: [upcoming, new] → 8 + 6 = 14 requests a day at most (free plan: 1,000/month).
export const MOTN_CATALOGS = {
  netflix: [2, 1], 'prime.subscription': [2, 1], hotstar: [1, 1], zee5: [1, 1], sonyliv: [1, 1], 'apple.subscription': [1, 1],
};
const CATALOG_NAMES = {
  netflix: 'Netflix', 'prime.subscription': 'Prime Video', hotstar: 'JioHotstar', zee5: 'ZEE5', sonyliv: 'SonyLIV', 'apple.subscription': 'Apple TV+',
};
const WATCHMODE_SERVICES = { Netflix: 'netflix', 'Prime Video': 'prime', 'AppleTV+': 'appletv', 'Apple TV+': 'appletv' };
const LANG3 = {
  hin: 'hi', eng: 'en', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn', mar: 'mr', pan: 'pa', guj: 'gu', kor: 'ko', jpn: 'ja',
};

export class SourceError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // auth | quota | network | http
  }
}

const istDate = (unixSeconds) => new Date((unixSeconds + 19800) * 1000).toISOString().slice(0, 10);
const safePoster = (u) => (typeof u === 'string' && /^https:\/\/cdn\.movieofthenight\.com\/[^"'<>\s]+$/.test(u) ? u : null);

async function getJson(url, key, name) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', 'X-API-Key': key }, referrerPolicy: 'no-referrer' });
  } catch {
    throw new SourceError('network', `Could not reach ${name}.`);
  }
  if (res.status === 401 || res.status === 403) throw new SourceError('auth', `${name} rejected the key.`);
  if (res.status === 429) throw new SourceError('quota', `${name}: request limit reached for now.`);
  if (!res.ok) throw new SourceError('http', `${name} returned an error (${res.status}).`);
  return res.json();
}

/** Cheap call to check a key before saving it. */
export async function testMotnKey(key) {
  await getJson(`${MOTN_BASE}/countries/in`, key, 'Movie of the Night');
}
export async function testWatchmodeKey(key) {
  await getJson(`${WATCHMODE_BASE}/regions/`, key, 'Watchmode');
}

export async function fetchMotn(key, changeType, catalog, maxPages, now = new Date()) {
  const minYear = now.getUTCFullYear() - 1;
  const rows = [];
  let cursor = '';
  let requests = 0;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({
      country: 'in', change_type: changeType, item_type: 'show', catalogs: catalog,
      order_direction: changeType === 'upcoming' ? 'asc' : 'desc', include_unknown_dates: 'false',
    });
    if (cursor) q.set('cursor', cursor);
    const d = await getJson(`${MOTN_BASE}/changes?${q}`, key, 'Movie of the Night');
    requests++;
    for (const c of d.changes || []) {
      const s = (d.shows || {})[c.showId];
      const platform = MOTN_SERVICES[c.service?.id];
      if (!s || !platform || !c.timestamp || !/^(movie|tv)\/\d+$/.test(s.tmdbId || '')) continue;
      const year = s.releaseYear || s.firstAirYear || 0;
      // "new" also lists old catalogue titles being (re)added; keep recent ones only.
      if (changeType === 'new' && year && year < minYear) continue;
      const [mediaType, id] = s.tmdbId.split('/');
      const audios = (s.streamingOptions?.in || [])
        .filter((o) => o.service?.id === c.service?.id)
        .flatMap((o) => (o.audios || []).map((a) => LANG3[a.language]).filter(Boolean));
      rows.push({
        source: 'motn', media_type: mediaType, tmdb_id: Number(id), platform, date: istDate(c.timestamp),
        title: String(s.title || '').slice(0, 200), poster_url: safePoster(s.imageSet?.verticalPoster?.w240),
        year: year || null, languages: [...new Set(audios)].join(',') || null, change: changeType,
        link: typeof c.link === 'string' && /^https:\/\/[^\s"'<>]+$/.test(c.link) ? c.link.slice(0, 300) : null,
      });
    }
    if (!d.hasMore || !d.nextCursor) break;
    cursor = d.nextCursor;
  }
  return { rows, requests };
}

export async function fetchWatchmode(key, now = new Date()) {
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const start = new Date(now.getTime() - 14 * 864e5);
  const end = new Date(now.getTime() + 45 * 864e5);
  const d = await getJson(`${WATCHMODE_BASE}/releases/?start_date=${ymd(start)}&end_date=${ymd(end)}&limit=250`, key, 'Watchmode');
  const list = Array.isArray(d) ? d : d.releases || [];
  const rows = [];
  for (const x of list) {
    const platform = WATCHMODE_SERVICES[x.source_name];
    const mediaType = x.tmdb_type === 'tv' ? 'tv' : x.tmdb_type === 'movie' ? 'movie' : null;
    if (!platform || !mediaType || !x.tmdb_id || !/^\d{4}-\d{2}-\d{2}$/.test(x.source_release_date || '')) continue;
    rows.push({
      source: 'watchmode', media_type: mediaType, tmdb_id: Number(x.tmdb_id), platform, date: x.source_release_date,
      title: String(x.title || '').slice(0, 200), poster_url: null, year: null, languages: null, change: 'release', link: null,
    });
  }
  return { rows, requests: 1 };
}

/**
 * One refresh with whichever keys are saved. Each service is independent: one failing doesn't stop
 * the rest. A rejected key stops that source (no point spending more requests).
 */
export async function refreshExtra({ motn, watchmode }, onProgress = () => {}, now = new Date()) {
  const jobs = [];
  if (motn) {
    for (const [i, changeType] of [[0, 'upcoming'], [1, 'new']]) {
      for (const [catalog, pages] of Object.entries(MOTN_CATALOGS)) {
        jobs.push({ source: `motn_${changeType}`, label: `${CATALOG_NAMES[catalog]} (${changeType})`, run: () => fetchMotn(motn, changeType, catalog, pages[i], now) });
      }
    }
  }
  if (watchmode) jobs.push({ source: 'watchmode', label: 'Watchmode', run: () => fetchWatchmode(watchmode, now) });
  const summary = { at: now.toISOString(), sources: {} };
  const rows = [];
  const dead = new Set();
  for (const [n, job] of jobs.entries()) {
    const s = (summary.sources[job.source] ||= { ok: true, rows: 0, requests: 0, errors: [] });
    const family = job.source.startsWith('motn') ? 'motn' : job.source;
    if (dead.has(family)) continue;
    onProgress(`${job.label}… (${n + 1} of ${jobs.length})`);
    try {
      const r = await job.run();
      rows.push(...r.rows);
      s.rows += r.rows.length;
      s.requests += r.requests;
    } catch (e) {
      s.errors.push(`${job.label}: ${e.message}`);
      if (e.kind === 'auth' || e.kind === 'quota') dead.add(family);
    }
  }
  for (const s of Object.values(summary.sources)) {
    s.ok = s.errors.length === 0;
    if (s.ok) delete s.errors;
    else s.error = s.errors.join('; ');
  }
  return { rows, summary };
}

/**
 * Upsert by (source, type, id, service), like the server table: a later "new" (actually added)
 * keeps its date over an "upcoming" announcement. Rows older than ~4 months are dropped.
 */
export function upsertRows(existing, incoming, today) {
  const key = (r) => `${r.source}|${r.media_type}|${r.tmdb_id}|${r.platform}`;
  const map = new Map(existing.map((r) => [key(r), r]));
  for (const r of incoming) {
    const cur = map.get(key(r));
    if (cur && cur.change === 'new' && r.change === 'upcoming') {
      map.set(key(r), { ...cur, languages: r.languages || cur.languages, poster_url: r.poster_url || cur.poster_url, link: cur.link || r.link });
    } else if (cur) {
      map.set(key(r), { ...r, languages: r.languages || cur.languages, poster_url: r.poster_url || cur.poster_url, link: r.link || cur.link });
    } else map.set(key(r), r);
  }
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 120 * 864e5).toISOString().slice(0, 10);
  return [...map.values()].filter((r) => r.date >= cutoff);
}
