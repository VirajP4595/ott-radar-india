// Small rendering helpers shared by every view.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function initials(t) {
  const words = String(t || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.slice(0, 2).map((w) => [...w.replace(/[^\p{L}\p{N}]/gu, '')][0] || '').join('').toUpperCase() || '?';
}

export function tintClass(t) {
  let h = 0;
  for (const ch of String(t || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `t${h % 8}`;
}

const LANGS = {
  hi: 'Hindi', en: 'English', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada',
  bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati', ko: 'Korean', ja: 'Japanese',
};
export const FILTER_LANGS = ['hi', 'en', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa', 'gu', 'ko'];
let names = null;
try { names = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { /* old browser */ }
export function langName(code) {
  if (!code) return '';
  if (LANGS[code]) return LANGS[code];
  try { return (names && names.of(code)) || code.toUpperCase(); } catch { return code.toUpperCase(); }
}

export const fmtRuntime = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`);

const svg = (d, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const icon = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  filter: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'),
  cal: svg('<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', 22),
  bookmark: svg('<path d="M6 4h12v16l-6-4-6 4z"/>', 22),
  bookmarkSm: svg('<path d="M6 4h12v16l-6-4-6 4z"/>', 18),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>', 22),
  left: svg('<path d="m15 18-6-6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  ext: svg('<path d="M7 17 17 7M8 7h9v9"/>', 16),
  bell: svg('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>', 22),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 18),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', 18),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  calAdd: svg('<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M12 13v5M9.5 15.5h5"/>', 18),
  grid: svg('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>', 18),
  list: svg('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>', 18),
  mark: svg('<path d="M6 4h12v16l-6-4-6 4z" fill="currentColor"/>', 14),
};
