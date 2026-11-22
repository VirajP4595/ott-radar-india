// Shared helpers for the /api/manual Pages Functions.
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
  return null;
}

export async function guardWrite(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: 'admin_not_configured' }, 503);
  if (!env.DB) return json({ error: 'db_not_configured' }, 503);
  if (!(await isAdmin(request, env))) return json({ error: 'unauthorized' }, 401);
  return null;
}
