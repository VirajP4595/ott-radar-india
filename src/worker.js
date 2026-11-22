// Cloudflare Worker entry. Static files in ./public are served by Workers Static Assets
// (including the _headers file). Only /api/* reaches this code.
//
//   GET    /api/manual?from=YYYY-MM-DD&to=YYYY-MM-DD   public list of manual entries
//   POST   /api/manual          (Authorization: Bearer ADMIN_TOKEN)  add an entry
//   DELETE /api/manual/:id      (Authorization: Bearer ADMIN_TOKEN)  delete an entry
//   GET    /api/logos           shared TMDB logo paths per platform
//   PUT    /api/logos           (Authorization: Bearer ADMIN_TOKEN)  save them
//   GET    /api/external?from&to  releases from Movie of the Night (India) + Watchmode, cached in D1
//   GET    /api/sync            when the last daily sync ran and what it fetched
//   POST   /api/sync            (Authorization: Bearer ADMIN_TOKEN)  run the sync now
import { json, listManual, createManual, deleteManual, getLogos, putLogos } from '../lib/manual.js';
import { listExternal, syncNow, syncStatus, runSync } from '../lib/external.js';

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
      if (pathname === '/api/sync' && request.method === 'POST') return await syncNow(request, env);
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

  // Daily cron (see wrangler.toml): refresh the extra release sources into D1.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env).then((s) => console.log('sync', JSON.stringify(s))));
  },
};
