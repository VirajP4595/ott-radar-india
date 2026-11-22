// GET  /api/manual?from=YYYY-MM-DD&to=YYYY-MM-DD  → public list of manual entries
// POST /api/manual  (Authorization: Bearer ADMIN_TOKEN) → add an entry
import { DATE, json, validateEntry, guardWrite } from '../../lib/manual.js';

const COLS = 'id, tmdb_id, media_type, title, poster_path, original_language, platform, date, status, label, source_url';

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const from = u.searchParams.get('from') || '';
  const to = u.searchParams.get('to') || '';
  if (!DATE.test(from) || !DATE.test(to) || from > to) return json({ error: 'bad_range' }, 400);
  if (!env.DB) return json({ entries: [], error: 'db_not_configured' });
  const { results } = await env.DB
    .prepare(`SELECT ${COLS} FROM manual WHERE date BETWEEN ?1 AND ?2 ORDER BY date, id LIMIT 2000`)
    .bind(from, to)
    .all();
  return json({ entries: results || [] });
}

export async function onRequestPost({ request, env }) {
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
  const row = await env.DB
    .prepare(`INSERT INTO manual (tmdb_id, media_type, title, poster_path, original_language, platform, date, status, label, source_url)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING ${COLS}`)
    .bind(
      b.tmdb_id ?? null, b.media_type, b.title.trim(), b.poster_path || null, b.original_language || null,
      b.platform, b.date, b.status, (b.label || '').trim() || null, b.source_url || null,
    )
    .first();
  return json({ entry: row }, 201);
}
