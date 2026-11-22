// Shared cache of extra-source results (Movie of the Night India, Watchmode).
// The keys never reach this server: the owner's browser fetches with its own keys and uploads
// the resulting rows here (admin token required), so visitors without keys see them too.
import { json, guardWrite, ensureSchema, PLATFORM_KEYS } from './manual.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 3000;

function validRow(r) {
  return r && typeof r === 'object'
    && ['motn', 'watchmode'].includes(r.source)
    && ['movie', 'tv'].includes(r.media_type)
    && Number.isInteger(r.tmdb_id) && r.tmdb_id > 0
    && PLATFORM_KEYS.has(r.platform)
    && typeof r.date === 'string' && DATE.test(r.date)
    && typeof r.title === 'string' && r.title.length <= 200
    && (r.poster_url == null || (typeof r.poster_url === 'string' && r.poster_url.length <= 1500 && /^https:\/\/cdn\.movieofthenight\.com\/[^"'<>\s]+$/.test(r.poster_url)))
    && (r.year == null || (Number.isInteger(r.year) && r.year > 1880 && r.year < 2100))
    && (r.languages == null || (typeof r.languages === 'string' && /^[a-z]{2}(,[a-z]{2}){0,15}$/.test(r.languages)))
    && ['upcoming', 'new', 'release'].includes(r.change)
    && (r.link == null || (typeof r.link === 'string' && r.link.length <= 300 && /^https:\/\/[^\s"'<>]+$/.test(r.link)));
}

async function saveRows(env, rows) {
  const stmt = env.DB.prepare(`INSERT INTO ext_releases
      (source, media_type, tmdb_id, platform, date, title, poster_url, year, languages, change, link, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))
    ON CONFLICT (source, media_type, tmdb_id, platform) DO UPDATE SET
      date = CASE WHEN ext_releases.change = 'new' AND excluded.change = 'upcoming' THEN ext_releases.date ELSE excluded.date END,
      change = CASE WHEN ext_releases.change = 'new' AND excluded.change = 'upcoming' THEN 'new' ELSE excluded.change END,
      title = excluded.title, poster_url = COALESCE(excluded.poster_url, ext_releases.poster_url),
      year = COALESCE(excluded.year, ext_releases.year),
      languages = COALESCE(excluded.languages, ext_releases.languages),
      link = COALESCE(excluded.link, ext_releases.link), updated_at = datetime('now')`);
  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(rows.slice(i, i + 50).map((r) => stmt.bind(
      r.source, r.media_type, r.tmdb_id, r.platform, r.date, r.title, r.poster_url ?? null, r.year ?? null,
      r.languages ?? null, r.change, r.link ?? null,
    )));
  }
}

/** PUT /api/external  { rows: [...], summary: {...} }  — owner only. */
export async function ingestExternal(request, env) {
  const denied = await guardWrite(request, env);
  if (denied) return denied;
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const rows = Array.isArray(b && b.rows) ? b.rows : null;
  if (!rows || rows.length > MAX_ROWS) return json({ error: 'bad_rows' }, 400);
  const bad = rows.findIndex((r) => !validRow(r));
  if (bad >= 0) return json({ error: 'bad_row', index: bad }, 400);
  await ensureSchema(env);
  await saveRows(env, rows);
  await env.DB.prepare("DELETE FROM ext_releases WHERE date < date('now', '-120 days')").run();
  const sources = {};
  for (const [k, v] of Object.entries((b.summary && b.summary.sources) || {})) {
    if (!/^[a-z_]{1,30}$/.test(k) || !v || typeof v !== 'object') continue;
    sources[k] = { ok: !!v.ok, rows: Number(v.rows) || 0, requests: Number(v.requests) || 0, ...(v.error ? { error: String(v.error).slice(0, 300) } : {}) };
  }
  const last = { at: new Date().toISOString(), rows: rows.length, sources };
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('last_sync', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(JSON.stringify(last)).run();
  return json({ saved: rows.length, last });
}

/** GET /api/external?from&to — public. */
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

/** GET /api/sync — when shared results were last uploaded. */
export async function syncStatus(request, env) {
  if (!env.DB) return json({ last: null });
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_sync'").first();
  let last = null;
  try { last = row ? JSON.parse(row.v) : null; } catch { last = null; }
  return json({ last });
}
