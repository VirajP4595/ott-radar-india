// DELETE /api/manual/:id  (Authorization: Bearer ADMIN_TOKEN)
import { json, guardWrite } from '../../../lib/manual.js';

export async function onRequestDelete({ request, env, params }) {
  const denied = await guardWrite(request, env);
  if (denied) return denied;
  if (!/^\d+$/.test(params.id || '')) return json({ error: 'bad_id' }, 400);
  const r = await env.DB.prepare('DELETE FROM manual WHERE id = ?1').bind(Number(params.id)).run();
  const changes = r.meta?.changes ?? 0;
  return changes ? json({ deleted: Number(params.id) }) : json({ error: 'not_found' }, 404);
}
