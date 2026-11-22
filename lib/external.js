// Extra release sources, fetched on the server once a day (Worker cron) with the owner's keys
// and cached in D1, so visitors need no keys and the free quotas are respected.
//
//  - Movie of the Night "Streaming Availability" (India): titles announced to arrive (upcoming)
//    and titles newly added (new) on Netflix, Prime Video, JioHotstar, ZEE5, SonyLIV, Apple TV+.
//  - Watchmode (free plan, US data): release dates of streaming originals. Used as a "Likely" date.
import { json, guardWrite, ensureSchema } from './manual.js';

const MOTN_SERVICES = { netflix: 'netflix', prime: 'prime', hotstar: 'jiohotstar', zee5: 'zee5', sonyliv: 'sonyliv', apple: 'appletv' };
// One request per service: asking for all six at once takes ~2 minutes per request on their side,
// one service takes a few seconds. Pages per run: [upcoming, new].
const MOTN_CATALOGS = {
  netflix: [2, 1], 'prime.subscription': [2, 1], hotstar: [1, 1], zee5: [1, 1], sonyliv: [1, 1], 'apple.subscription': [1, 1],
};
const WATCHMODE_SERVICES = { Netflix: 'netflix', 'Prime Video': 'prime', 'AppleTV+': 'appletv', 'Apple TV+': 'appletv' };
const LANG3 = {
  hin: 'hi', eng: 'en', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn', mar: 'mr', pan: 'pa', guj: 'gu', kor: 'ko', jpn: 'ja',
};
// Requests per daily run (free plan: 1,000/month): 8 upcoming + 6 new = 14 a day, about 420 a month.
const TIME_BUDGET_MS = 8 * 60e3; // stay well inside the Worker cron limit

const istDate = (unixSeconds) => new Date((unixSeconds + 19800) * 1000).toISOString().slice(0, 10);
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/cdn\.movieofthenight\.com\//.test(u) ? u : null);

async function getJson(url, headers) {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

/** Movie of the Night changes for India, one service ("catalog") → normalized rows. */
export async function fetchMotn(env, changeType, catalog, maxPages, now = new Date()) {
  const base = env.MOTN_BASE || 'https://api.movieofthenight.com/v4';
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
    const d = await getJson(`${base}/changes?${q}`, { 'X-API-Key': env.MOTN_API_KEY });
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
        title: String(s.title || '').slice(0, 200), poster_url: safeUrl(s.imageSet?.verticalPoster?.w240),
        year: year || null, languages: [...new Set(audios)].join(',') || null, change: changeType,
        link: typeof c.link === 'string' && /^https:\/\//.test(c.link) ? c.link.slice(0, 300) : null,
      });
    }
    if (!d.hasMore || !d.nextCursor) break;
    cursor = d.nextCursor;
  }
  return { rows, requests };
}

/** Watchmode free "releases" feed (US). Only services that release worldwide are kept. */
export async function fetchWatchmode(env, now = new Date()) {
  const base = env.WATCHMODE_BASE || 'https://api.watchmode.com/v1';
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const start = new Date(now.getTime() - 14 * 864e5);
  const end = new Date(now.getTime() + 45 * 864e5);
  const d = await getJson(`${base}/releases/?start_date=${ymd(start)}&end_date=${ymd(end)}&limit=250`, { 'X-API-Key': env.WATCHMODE_API_KEY });
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

async function saveRows(env, rows) {
  if (!rows.length) return;
  const stmt = env.DB.prepare(`INSERT INTO ext_releases
      (source, media_type, tmdb_id, platform, date, title, poster_url, year, languages, change, link, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))
    ON CONFLICT (source, media_type, tmdb_id, platform) DO UPDATE SET
      date = CASE WHEN ext_releases.change = 'new' AND excluded.change = 'upcoming' THEN ext_releases.date ELSE excluded.date END,
      change = CASE WHEN ext_releases.change = 'new' THEN 'new' ELSE excluded.change END,
      title = excluded.title, poster_url = COALESCE(excluded.poster_url, ext_releases.poster_url),
      year = COALESCE(excluded.year, ext_releases.year),
      languages = COALESCE(excluded.languages, ext_releases.languages),
      link = COALESCE(excluded.link, ext_releases.link), updated_at = datetime('now')`);
  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(rows.slice(i, i + 50).map((r) => stmt.bind(
      r.source, r.media_type, r.tmdb_id, r.platform, r.date, r.title, r.poster_url, r.year, r.languages, r.change, r.link,
    )));
  }
}

/** One sync run: each source is independent, so one failing doesn't block the others. */
export async function runSync(env, now = new Date()) {
  await ensureSchema(env);
  const summary = { at: now.toISOString(), sources: {} };
  const started = Date.now();
  const jobs = [];
  if (env.MOTN_API_KEY) {
    for (const [i, changeType] of [[0, 'upcoming'], [1, 'new']]) {
      for (const [catalog, pages] of Object.entries(MOTN_CATALOGS)) {
        jobs.push([`motn_${changeType}`, catalog, () => fetchMotn(env, changeType, catalog, pages[i], now)]);
      }
    }
  }
  if (env.WATCHMODE_API_KEY) jobs.push(['watchmode', 'releases', () => fetchWatchmode(env, now)]);
  // Each service is independent: one failing (or running out of time) doesn't block the rest.
  for (const [name, part, job] of jobs) {
    const s = (summary.sources[name] ||= { ok: true, rows: 0, requests: 0, errors: [] });
    if (Date.now() - started > TIME_BUDGET_MS) { s.errors.push(`${part}: skipped (time budget)`); continue; }
    try {
      const { rows, requests } = await job();
      await saveRows(env, rows);
      s.rows += rows.length;
      s.requests += requests;
    } catch (e) {
      s.errors.push(`${part}: ${String((e && e.message) || e).slice(0, 120)}`);
    }
  }
  for (const s of Object.values(summary.sources)) {
    s.ok = s.errors.length === 0;
    if (s.ok) delete s.errors;
    else s.error = s.errors.join('; ');
  }
  if (!jobs.length) summary.note = 'No MOTN_API_KEY or WATCHMODE_API_KEY secret set';
  // Forget rows older than ~4 months so the table stays small.
  await env.DB.prepare("DELETE FROM ext_releases WHERE date < date('now', '-120 days')").run();
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('last_sync', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(JSON.stringify(summary)).run();
  return summary;
}

// ---- HTTP handlers
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function listExternal(request, env) {
  const u = new URL(request.url);
  const from = u.searchParams.get('from') || '';
  const to = u.searchParams.get('to') || '';
  if (!DATE.test(from) || !DATE.test(to) || from > to) return json({ error: 'bad_range' }, 400);
  if (!env.DB) return json({ entries: [] });
  await ensureSchema(env);
  const { results } = await env.DB.prepare(`SELECT source, media_type, tmdb_id, platform, date, title, poster_url, year, languages, change, link
      FROM ext_releases WHERE date BETWEEN ?1 AND ?2 ORDER BY date LIMIT 3000`).bind(from, to).all();
  return json({ entries: results || [] });
}

export async function syncNow(request, env) {
  const denied = await guardWrite(request, env);
  if (denied) return denied;
  return json(await runSync(env));
}

export async function syncStatus(request, env) {
  if (!env.DB) return json({ last: null });
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_sync'").first();
  let last = null;
  try { last = row ? JSON.parse(row.v) : null; } catch { last = null; }
  return json({ last, sources: { motn: !!env.MOTN_API_KEY, watchmode: !!env.WATCHMODE_API_KEY } });
}
