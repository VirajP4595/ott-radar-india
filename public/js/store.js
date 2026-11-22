// Everything the app remembers lives in this browser's localStorage.
// Every access is wrapped: private windows or blocked storage must not break the app.
const P = 'ottr:';

function read(k, fallback) {
  try {
    const v = localStorage.getItem(P + k);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function write(k, v) {
  try {
    localStorage.setItem(P + k, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}
function remove(k) {
  try { localStorage.removeItem(P + k); } catch { /* ignore */ }
}

// ---- TMDB token (the user's own) and owner admin token
export const getToken = () => read('token', '');
export const setToken = (t) => write('token', t);
export const clearToken = () => remove('token');
export const getAdminToken = () => read('admin', '');
export const setAdminToken = (t) => write('admin', t);
export const clearAdminToken = () => remove('admin');
export const getLastFetch = () => read('lastFetch', 0);
export const setLastFetch = (t) => write('lastFetch', t);

// ---- Filters
export const DEFAULT_FILTERS = Object.freeze({
  platforms: [], languages: [], type: 'all', episodes: false, confirmedOnly: false,
});
export function getFilters() {
  const f = { ...DEFAULT_FILTERS, ...read('filters', {}) };
  if (!Array.isArray(f.platforms)) f.platforms = [];
  if (!Array.isArray(f.languages)) f.languages = [];
  return f;
}
export const setFilters = (f) => write('filters', f);
export const filtersActive = (f = getFilters()) =>
  f.platforms.length > 0 || f.languages.length > 0 || f.type !== 'all' || f.episodes || f.confirmedOnly;

// ---- Watchlist
export const getWatchlist = () => {
  const w = read('watchlist', []);
  return Array.isArray(w) ? w : [];
};
export const setWatchlist = (w) => write('watchlist', w);
export const inWatchlist = (key) => getWatchlist().some((i) => i.key === key);
export function toggleWatch(item) {
  const w = getWatchlist();
  const i = w.findIndex((x) => x.key === item.key);
  if (i >= 0) w.splice(i, 1);
  else w.push({ ...item, added: Date.now() });
  setWatchlist(w);
  return i < 0;
}
export const getNotified = () => read('notified', []);
export const setNotified = (n) => write('notified', n);

// ---- Cache with expiry
export function cacheGet(k) {
  const e = read('c:' + k, null);
  if (!e) return null;
  if (e.x < Date.now()) {
    remove('c:' + k);
    return null;
  }
  return e.v;
}
export function cacheSet(k, v, ttlMs) {
  const e = { x: Date.now() + ttlMs, v };
  if (!write('c:' + k, e)) {
    pruneCache(false);
    if (!write('c:' + k, e)) {
      pruneCache(true);
      write('c:' + k, e);
    }
  }
}
export function cacheRemovePrefix(prefix) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(P + 'c:' + prefix)) localStorage.removeItem(key);
    }
  } catch { /* ignore */ }
}
export function pruneCache(all) {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(P + 'c:')) continue;
      if (all) { localStorage.removeItem(key); continue; }
      try {
        if (JSON.parse(localStorage.getItem(key)).x < now) localStorage.removeItem(key);
      } catch {
        localStorage.removeItem(key);
      }
    }
  } catch { /* ignore */ }
}
export const clearCache = () => pruneCache(true);
