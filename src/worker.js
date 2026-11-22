// Cloudflare Worker entry. Static files in ./public are served by Workers Static Assets
// (including the _headers file). Only /api/* reaches this code.
//
//   GET    /api/manual?from=YYYY-MM-DD&to=YYYY-MM-DD   public list of manual entries
//   POST   /api/manual          (Authorization: Bearer ADMIN_TOKEN)  add an entry
//   DELETE /api/manual/:id      (Authorization: Bearer ADMIN_TOKEN)  delete an entry
//   GET    /api/logos           shared TMDB logo paths per platform
//   PUT    /api/logos           (Authorization: Bearer ADMIN_TOKEN)  save them
//   GET    /api/external?from&to  shared extra-source rows (Movie of the Night India, Watchmode)
//   PUT    /api/external        (Authorization: Bearer ADMIN_TOKEN)  owner's browser uploads rows it fetched
//                                with its own keys (the keys never reach this server)
//   GET    /api/sync            when shared rows were last uploaded
import { json, listManual, createManual, deleteManual, getLogos, putLogos } from '../lib/manual.js';
import { listExternal, ingestExternal, syncStatus } from '../lib/external.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/manual') {
        if (request.method === 'GET') return await listManual(request, env);
        if (request.method === 'POST') return await createManual(request, env);
        return json({ error: 'method_not_allowed' }, 405);
      }
      if (pathname === '/api/external' && request.method === 'GET') return await listExternal(request, env);
      if (pathname === '/api/external' && request.method === 'PUT') return await ingestExternal(request, env);
      if (pathname === '/api/sync' && request.method === 'GET') return await syncStatus(request, env);
      if (pathname === '/api/logos') {
        if (request.method === 'GET') return await getLogos(request, env);
        if (request.method === 'PUT') return await putLogos(request, env);
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
