// Cloudflare Worker entry. Static files in ./public are served by Workers Static Assets
// (including the _headers file). Only /api/* reaches this code.
//
//   GET    /api/manual?from=YYYY-MM-DD&to=YYYY-MM-DD   public list of manual entries
//   POST   /api/manual          (Authorization: Bearer ADMIN_TOKEN)  add an entry
//   DELETE /api/manual/:id      (Authorization: Bearer ADMIN_TOKEN)  delete an entry
import { json, listManual, createManual, deleteManual } from '../lib/manual.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/manual') {
        if (request.method === 'GET') return await listManual(request, env);
        if (request.method === 'POST') return await createManual(request, env);
        return json({ error: 'method_not_allowed' }, 405);
      }
      const m = pathname.match(/^\/api\/manual\/([^/]+)$/);
      if (m) {
        if (request.method === 'DELETE') return await deleteManual(request, env, m[1]);
        return json({ error: 'method_not_allowed' }, 405);
      }
      if (pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'server_error' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};
