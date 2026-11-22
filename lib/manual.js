// /api/manual handlers: validation, owner auth and D1 queries.
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const PLATFORM_KEYS = new Set([
  'netflix', 'mxplayer', 'prime', 'jiohotstar', 'zee5', 'sonyliv', 'aha', 'sunnxt',
  'appletv', 'hoichoi', 'manoramamax', 'etvwin',
]);

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** Constant-time check of "Authorization: Bearer <ADMIN_TOKEN>". */
export async function isAdmin(request, env) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m || !env.ADMIN_TOKEN) return false;
  const [a, b] = await Promise.all([sha256(m[1].trim()), sha256(String(env.ADMIN_TOKEN))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Returns an error code string, or null when the entry is valid. */
export function validateEntry(b) {
  if (!b || typeof b !== 'object') return 'bad_body';
  if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) return 'bad_title';
  if (!['movie', 'tv'].includes(b.media_type)) return 'bad_media_type';
  if (b.tmdb_id != null && !(Number.isInteger(b.tmdb_id) && b.tmdb_id > 0)) return 'bad_tmdb_id';
  if (!PLATFORM_KEYS.has(b.platform)) return 'bad_platform';
  if (typeof b.date !== 'string' || !DATE.test(b.date) || Number.isNaN(Date.parse(b.date))) return 'bad_date';
  if (!['Expected', 'Confirmed'].includes(b.status)) return 'bad_status';
  if (b.label != null && (typeof b.label !== 'string' || b.label.length > 60)) return 'bad_label';
  if (b.source_url != null && b.source_url !== '' && (typeof b.source_url !== 'string' || b.source_url.length > 500 || !/^https?:\/\/[^\s]+$/i.test(b.source_url))) return 'bad_source_url';
  if (b.poster_path != null && (typeof b.poster_path !== 'string' || !/^\/[\w.-]+$/.test(b.poster_path))) return 'bad_poster_path';
  if (b.original_language != null && b.original_language !== '' && !/^[a-z]{2}$/.test(b.original_language)) return 'bad_language';
  if (b.languages != null && (!Array.isArray(b.languages) || b.languages.length > 15 || !b.languages.every((l) => typeof l === 'string' && /^[a-z]{2}$/.test(l)))) return 'bad_languages';
  return null;
}

export async function guardWrite(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: 'admin_not_configured' }, 503);
  if (!env.DB) return json({ error: 'db_not_configured' }, 503);
  if (!(await isAdmin(request, env))) return json({ error: 'unauthorized' }, 401);
  return null;
}

const COLS = 'id, tmdb_id, media_type, title, poster_path, original_language, languages, platform, date, status, label, source_url';

// Databases created before the "languages" column existed get it added automatically, once.
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady || !env.DB) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  const { results } = await env.DB.prepare('PRAGMA table_info(manual)').all();
  if (results && results.length && !results.some((c) => c.name === 'languages')) {
    try {
      await env.DB.prepare('ALTER TABLE manual ADD COLUMN languages TEXT').run();
    } catch (e) {
      if (!/duplicate column/i.test(String(e && e.message))) throw e; // another request added it first
    }
  }
  schemaReady = true;
}

export async function listManual(request, env) {
  const u = new URL(request.url);
  const from = u.searchParams.get('from') || '';
  const to = u.searchParams.get('to') || '';
  if (!DATE.test(from) || !DATE.test(to) || from > to) return json({ error: 'bad_range' }, 400);
  if (!env.DB) return json({ entries: [], error: 'db_not_configured' });
  await ensureSchema(env);
  const { results } = await env.DB
    .prepare(`SELECT ${COLS} FROM manual WHERE date BETWEEN ?1 AND ?2 ORDER BY date, id LIMIT 2000`)
    .bind(from, to)
    .all();
  return json({ entries: results || [] });
}

export async function createManual(request, env) {
  const denied = await guardWrite(request, env);
  if (denied) return denied;
  let b;
  try {
    b = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  const err = validateEntry(b);
  if (err) return json({ error: err }, 400);
  await ensureSchema(env);
  const langs = [...new Set([b.original_language, ...(b.languages || [])].filter(Boolean))].join(',');
  const row = await env.DB
    .prepare(`INSERT INTO manual (tmdb_id, media_type, title, poster_path, original_language, languages, platform, date, status, label, source_url)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING ${COLS}`)
    .bind(
      b.tmdb_id ?? null, b.media_type, b.title.trim(), b.poster_path || null, b.original_language || null,
      langs || null, b.platform, b.date, b.status, (b.label || '').trim() || null, b.source_url || null,
    )
    .first();
  return json({ entry: row }, 201);
}

export async function deleteManual(request, env, id) {
  const denied = await guardWrite(request, env);
  if (denied) return denied;
  if (!/^\d+$/.test(id || '')) return json({ error: 'bad_id' }, 400);
  const r = await env.DB.prepare('DELETE FROM manual WHERE id = ?1').bind(Number(id)).run();
  return (r.meta?.changes ?? 0) ? json({ deleted: Number(id) }) : json({ error: 'not_found' }, 404);
}

// ---- Shared platform logos: TMDB logo paths saved by the owner's browser, so visitors
// without a TMDB token still see the official logos (images load from image.tmdb.org).
export async function getLogos(request, env) {
  if (!env.DB) return json({ logos: {} });
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'logos'").first();
  let logos = {};
  try { logos = row ? JSON.parse(row.v) : {}; } catch { logos = {}; }
  return json({ logos });
}

export async function putLogos(request, env) {
  const denied = await guardWrite(request, env);
  if (denied) return denied;
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const logos = {};
  for (const [k, v] of Object.entries((b && b.logos) || {})) {
    if (!PLATFORM_KEYS.has(k) || typeof v !== 'string' || !/^\/[\w.-]+$/.test(v)) return json({ error: 'bad_logos' }, 400);
    logos[k] = v;
  }
  await ensureSchema(env);
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('logos', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(logos)).run();
  return json({ logos });
}
