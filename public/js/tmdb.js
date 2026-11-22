// Minimal TMDB client that runs in the browser with the user's own token.
// The token is sent only to api.themoviedb.org.
const BASE = 'https://api.themoviedb.org/3';

export class TmdbError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // auth | network | notfound | http
  }
}

export class Tmdb {
  constructor(token) {
    this.token = String(token || '').trim();
    // "API Read Access Token" is a JWT (starts with eyJ); the older "API Key" is 32 hex chars.
    this.bearer = this.token.startsWith('eyJ');
  }

  async get(path, params = {}) {
    const u = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    const headers = { accept: 'application/json' };
    if (this.bearer) headers.authorization = `Bearer ${this.token}`;
    else u.searchParams.set('api_key', this.token);

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(u, { headers, referrerPolicy: 'no-referrer' });
      } catch {
        throw new TmdbError('network', 'Could not reach TMDB. Check your internet connection.');
      }
      if (res.ok) return res.json();
      if (res.status === 401) throw new TmdbError('auth', 'TMDB rejected this token. Check that you copied all of it.');
      if (res.status === 404) throw new TmdbError('notfound', 'Not found on TMDB.');
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      throw new TmdbError('http', `TMDB returned an error (${res.status}).`);
    }
  }

  validate() {
    return this.get('/configuration');
  }
}

/** Safe TMDB image URL (paths look like "/abc123.jpg"). */
export function img(path, size = 'w185') {
  return typeof path === 'string' && /^\/[\w.-]+$/.test(path)
    ? `https://image.tmdb.org/t/p/${size}${path}`
    : '';
}

/**
 * Run fn over items with at most n in flight. Results keep input order.
 * Auth and network errors abort the whole run; other per-item failures become null.
 */
export async function pool(items, n, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  let fatal = null;
  const worker = async () => {
    while (next < items.length && !fatal) {
      const idx = next++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        if (e && (e.kind === 'auth' || e.kind === 'network')) fatal = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (fatal) throw fatal;
  return out;
}
