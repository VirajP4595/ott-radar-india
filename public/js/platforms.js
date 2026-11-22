// Indian streaming platforms the app tracks. Logos are NOT bundled: the official
// logos come from TMDB's watch-provider list at runtime (see loadProviderMap).
import { cacheGet, cacheSet } from './store.js';

// Order matters: the first match wins (MX Player before Prime so "Amazon MX Player" maps correctly).
export const PLATFORMS = [
  { key: 'netflix', name: 'Netflix', aliases: ['netflix'] },
  { key: 'mxplayer', name: 'MX Player', aliases: ['mx player', 'amazon mx'] },
  { key: 'prime', name: 'Prime Video', aliases: ['prime video', 'amazon prime'] },
  { key: 'jiohotstar', name: 'JioHotstar', aliases: ['jiohotstar', 'jio hotstar', 'hotstar', 'jiocinema', 'jio cinema'] },
  { key: 'zee5', name: 'ZEE5', aliases: ['zee5', 'zee 5'] },
  { key: 'sonyliv', name: 'SonyLIV', aliases: ['sonyliv', 'sony liv'] },
  { key: 'aha', name: 'Aha', aliases: ['aha'] },
  { key: 'sunnxt', name: 'Sun NXT', aliases: ['sun nxt', 'sunnxt'] },
  { key: 'appletv', name: 'Apple TV+', aliases: ['apple tv'] },
  { key: 'hoichoi', name: 'Hoichoi', aliases: ['hoichoi'] },
  { key: 'manoramamax', name: 'ManoramaMAX', aliases: ['manorama'] },
  { key: 'etvwin', name: 'ETV Win', aliases: ['etv win'] },
];

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const p of PLATFORMS) {
  p.re = new RegExp(`(^|[^a-z0-9])(${p.aliases.map(escRe).join('|')})($|[^a-z0-9])`, 'i');
}

export const platformByKey = (k) => PLATFORMS.find((p) => p.key === k);
export const PLATFORM_KEYS = PLATFORMS.map((p) => p.key);

/** Map a provider name or a free-text release note to a platform key. */
export function keyForText(text) {
  if (!text) return null;
  const p = PLATFORMS.find((x) => x.re.test(text));
  return p ? p.key : null;
}
/** All platform keys mentioned in a free-text note (TMDB release-date notes often name the service). */
export function keysInText(text) {
  if (!text) return [];
  return PLATFORMS.filter((p) => p.re.test(text)).map((p) => p.key);
}

/** Provider id → platform key, plus the official logo path per platform, for region India. */
export async function loadProviderMap(tmdb) {
  const cached = cacheGet('providers');
  if (cached) return cached;
  const [movie, tv] = await Promise.all([
    tmdb.get('/watch/providers/movie', { watch_region: 'IN' }),
    tmdb.get('/watch/providers/tv', { watch_region: 'IN' }),
  ]);
  const ids = {};
  const logos = {};
  const rank = {};
  for (const r of [...(movie.results || []), ...(tv.results || [])]) {
    const k = keyForText(r.provider_name);
    if (!k) continue;
    ids[r.provider_id] = k;
    // Prefer the plain provider (not "with Ads" / channel variants) and India's display priority.
    const variant = /with ads|channel|kids/i.test(r.provider_name) ? 1000 : 0;
    const pr = variant + (r.display_priorities?.IN ?? r.display_priority ?? 999);
    if (r.logo_path && (rank[k] == null || pr < rank[k])) {
      logos[k] = r.logo_path;
      rank[k] = pr;
    }
  }
  const map = { ids, logos };
  cacheSet('providers', map, 7 * 24 * 3600e3);
  return map;
}

export const idsForKeys = (map, keys) =>
  Object.entries(map.ids).filter(([, k]) => keys.includes(k)).map(([id]) => id);
