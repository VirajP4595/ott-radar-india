import * as S from './store.js';
import * as D from './dates.js';
import { Tmdb, img } from './tmdb.js';
import { PLATFORMS, platformByKey, keyForText, loadProviderMap } from './platforms.js';
import { loadMonth, fetchManual, clearManualCache, mergeReleases, applyFilters } from './releases.js';
import { esc, initials, tintClass, langName, fmtRuntime, icon, FILTER_LANGS } from './ui.js';
import { buildIcs, downloadIcs } from './ics.js';

const H = 3600e3;
const $app = document.getElementById('app');
const state = {
  tmdb: null,
  providers: null,
  months: new Map(), // "YYYY-MM" → merged release list
  loading: new Map(), // "YYYY-MM" → Promise
  progress: null,
  authError: false,
  netError: '',
  tokenError: '',
  editToken: false,
  search: { q: '', results: null, error: '' },
  watchKeys: new Set(),
  admin: { results: null, sel: null, status: 'Expected', list: null, error: '', busy: false, prefilled: '' },
};

function initTmdb() {
  const t = S.getToken();
  state.tmdb = t ? new Tmdb(t) : null;
}

// ---------------------------------------------------------------- data
async function ensureProviders() {
  if (state.providers || !state.tmdb) return;
  state.providers = await loadProviderMap(state.tmdb);
}

function ensureMonth(mk) {
  if (state.months.has(mk)) return Promise.resolve(state.months.get(mk));
  if (state.loading.has(mk)) return state.loading.get(mk);
  const p = (async () => {
    const manualP = fetchManual(D.monthStart(mk), D.monthEnd(mk));
    let list = [];
    if (state.tmdb && !state.authError) {
      try {
        await ensureProviders();
        list = await loadMonth(state.tmdb, state.providers, mk, (done, total) => setProgress(done, total));
        S.setLastFetch(Date.now());
      } catch (e) {
        if (e.kind === 'auth') state.authError = true;
        else state.netError = e.message || 'Something went wrong while loading from TMDB.';
      }
    }
    const merged = mergeReleases(list, await manualP);
    state.months.set(mk, merged);
    state.loading.delete(mk);
    state.progress = null;
    syncWatchlist(merged);
    return merged;
  })();
  state.loading.set(mk, p);
  return p;
}

function collect(months, from, to) {
  if (!months.every((m) => state.months.has(m))) return null;
  return months.flatMap((m) => state.months.get(m)).filter((r) => r.date >= from && r.date <= to);
}

function setProgress(done, total) {
  state.progress = { done, total };
  const el = document.getElementById('progress-bar');
  const tx = document.getElementById('progress-text');
  if (el && total) el.style.width = `${Math.round((done / total) * 100)}%`;
  if (tx) tx.textContent = total ? `Loading from TMDB… ${done} of ${total} titles` : 'Loading from TMDB…';
}

function findRelease(key) {
  const all = [...state.months.values()].flat().filter((r) => r.key === key);
  if (!all.length) return null;
  const t = D.today();
  return all.find((r) => r.date >= t) || all[all.length - 1];
}

function syncWatchlist(list) {
  const w = S.getWatchlist();
  let changed = false;
  for (const item of w) {
    const rel = list.filter((r) => r.key === item.key).sort((a, b) => (a.date < b.date ? -1 : 1));
    const pick = rel.find((r) => r.date >= D.today()) || rel[rel.length - 1];
    if (pick && (pick.date !== item.date || pick.status !== item.status)) {
      Object.assign(item, { date: pick.date, status: pick.status, platforms: pick.platforms });
      changed = true;
    }
  }
  if (changed) S.setWatchlist(w);
  checkReminders();
}

// ---------------------------------------------------------------- small UI pieces
const isToday = (d) => d === D.today();

function pLogo(key) {
  const logo = state.providers?.logos?.[key];
  return logo
    ? `<img class="plogo" src="${img(logo, 'w92')}" alt="" width="20" height="20" loading="lazy">`
    : `<span class="pdot p-${esc(key)}"></span>`;
}
function pTag(key) {
  return `<span class="ptag">${pLogo(key)}${esc(platformByKey(key)?.name || key)}</span>`;
}
function kindText(r) {
  if (r.mediaType === 'movie') return 'Movie';
  return r.label || (r.kind === 'series' ? 'New series' : 'Series');
}
function metaText(r) {
  return [kindText(r), langName(r.lang), r.runtime ? fmtRuntime(r.runtime) : '', (r.genres || [])[0]]
    .filter(Boolean).join(' · ');
}
function statusTag(r) {
  if (r.conflict) return `<span class="status bad" title="TMDB says ${esc(D.fmtDate(r.conflict))}">Dates disagree</span>`;
  return `<span class="status ${r.status === 'Confirmed' ? 'ok' : 'warn'}">${esc(r.status)}</span>`;
}
function posterBox(r, size) {
  const src = img(r.poster, size);
  return `<div class="poster ${tintClass(r.title)}" aria-hidden="true">${src ? `<img src="${src}" alt="" loading="lazy">` : `<span>${esc(initials(r.title))}</span>`}</div>`;
}
const titleHref = (r) => (r.tmdbId ? `#/title/${r.mediaType}/${r.tmdbId}` : '#/');

function kindBadge(r) {
  if (r.finale) return `<span class="kbadge fin">${r.finale === 'mid_season' ? 'Mid-season finale' : 'Finale'}</span>`;
  if (r.kind === 'series') return '<span class="kbadge prem">New series</span>';
  if (r.kind === 'season') return '<span class="kbadge prem">Premiere</span>';
  return '';
}
const wmark = (r) => (state.watchKeys.has(r.key) ? `<span class="wmark" title="In your watchlist"><span class="sr-only">In your watchlist</span>${icon.mark}</span>` : '');

function cardLg(r) {
  return `<a class="card ${state.watchKeys.has(r.key) ? 'is-mine' : ''}" href="${titleHref(r)}">${posterBox(r, 'w185')}
    <div class="card-body"><span class="card-title">${wmark(r)}${esc(r.title)}</span>
    <span class="card-meta">${esc(metaText(r))}</span>
    <div class="card-tags">${r.platforms.map(pTag).join('')}${kindBadge(r)}${statusTag(r)}</div></div></a>`;
}
function cardSm(r) {
  const name = platformByKey(r.platforms[0])?.name || '';
  return `<a class="row ${state.watchKeys.has(r.key) ? 'is-mine' : ''}" href="${titleHref(r)}">${posterBox(r, 'w92')}
    <div class="row-body"><span class="row-title">${wmark(r)}${esc(r.title)}</span><span class="row-meta">${esc(metaText(r))}</span></div>
    <span class="row-plat">${pLogo(r.platforms[0])}<span class="row-pname">${esc(name)}</span></span></a>`;
}
function tile(r) {
  const sub = r.mediaType === 'movie' ? 'Movie' : (r.label || 'Series');
  return `<a class="tile ${state.watchKeys.has(r.key) ? 'is-mine' : ''}" href="${titleHref(r)}">
    <div class="tile-art">${posterBox(r, 'w342')}<span class="tile-badges">${kindBadge(r)}${r.status === 'Expected' || r.conflict ? statusTag(r) : ''}</span>${wmark(r)}</div>
    <span class="tile-title">${esc(r.title)}</span>
    <span class="tile-meta">${pLogo(r.platforms[0])}<span>${esc(sub)}</span></span></a>`;
}
function listOrTiles(items, size) {
  if (S.getLayout() === 'posters') return `<div class="tiles">${items.map(tile).join('')}</div>`;
  return size === 'lg' ? `<div class="cards">${items.map(cardLg).join('')}</div>` : `<div class="rows">${items.map(cardSm).join('')}</div>`;
}
const KIND_TABS = [['all', 'All'], ['premieres', 'Premieres'], ['movies', 'Movies'], ['finales', 'Finales']];
function kindTabs(withLayout) {
  const f = S.getFilters();
  const lay = S.getLayout();
  return `<div class="kindbar">
    <div class="chips" role="group" aria-label="Release type">${KIND_TABS.map(([k, l]) =>
    `<button class="chip ${f.kind === k ? 'on' : ''}" data-action="set-kind" data-key="${k}" aria-pressed="${f.kind === k}">${l}</button>`).join('')}
      <button class="chip mine ${f.mine ? 'on' : ''}" data-action="toggle-mine" aria-pressed="${f.mine}">${icon.mark}My watchlist</button></div>
    ${withLayout ? `<div class="laytoggle" role="group" aria-label="Layout">
      <button class="iconbtn ghost ${lay === 'list' ? 'on' : ''}" data-action="set-layout" data-key="list" aria-pressed="${lay === 'list'}" aria-label="List layout">${icon.list}</button>
      <button class="iconbtn ghost ${lay === 'posters' ? 'on' : ''}" data-action="set-layout" data-key="posters" aria-pressed="${lay === 'posters'}" aria-label="Posters layout">${icon.grid}</button></div>` : ''}
  </div>`;
}
function emptyFor(scope) {
  const f = S.getFilters();
  if (f.mine) return `Nothing from your watchlist ${scope}.`;
  return { premieres: `No premieres ${scope}.`, movies: `No movies ${scope}.`, finales: `No finales ${scope}.` }[f.kind] || `Nothing tracked ${scope} yet.`;
}

function navLinks(active, cls) {
  const items = [
    ['releases', '#/', 'Releases', icon.cal],
    ['watchlist', '#/watchlist', 'Watchlist', icon.bookmark],
    ['settings', '#/settings', 'Settings', icon.settings],
  ];
  return `<nav class="${cls}" aria-label="Main">${items.map(([k, href, label, ic]) =>
    `<a href="${href}" class="${k === active ? 'on' : ''}" ${k === active ? 'aria-current="page"' : ''}>${ic}<span>${label}</span></a>`).join('')}</nav>`;
}

function headerActions() {
  const back = encodeURIComponent(location.hash || '#/');
  return `<a class="iconbtn" href="#/search" aria-label="Search titles">${icon.search}</a>
    <a class="iconbtn" href="#/filters?back=${back}" aria-label="Filters">${icon.filter}${S.filtersActive() ? '<span class="badge-dot"></span>' : ''}</a>`;
}

function banners({ connect = false } = {}) {
  let out = '';
  if (state.authError) {
    out += `<div class="banner bad" role="alert">TMDB rejected your token. <a href="#/settings">Update it in Settings</a>.</div>`;
  } else if (state.netError) {
    out += `<div class="banner warn" role="alert">${esc(state.netError)} <button class="linkbtn" data-action="retry">Try again</button></div>`;
  }
  if (connect && !state.tmdb) {
    out += `<div class="banner info"><strong>Connect TMDB to load releases.</strong> OTT Radar uses your own free TMDB token, saved only on this device. <a href="#/settings">Connect now</a></div>`;
  }
  return out;
}

function page({ nav = 'releases', subtitle = '', body, sidebar = '', connect = false, actions = true, cls = '' }) {
  return `<div class="shell ${cls}">
    <header class="topbar">
      <div class="brand"><a class="brand-name" href="#/">OTT Radar</a>${subtitle ? `<span class="brand-sub">${esc(subtitle)}</span>` : ''}</div>
      ${navLinks(nav, 'topnav')}
      ${actions ? `<div class="actions">${headerActions()}</div>` : ''}
    </header>
    <div class="banners">${banners({ connect })}</div>
    <div class="layout ${sidebar ? 'with-side' : ''}">
      ${sidebar ? `<aside class="sidebar" aria-label="Filters">${sidebar}</aside>` : ''}
      <main class="main" id="main">${body}</main>
    </div>
    ${navLinks(nav, 'bottomnav')}
  </div>`;
}

function loadingBlock() {
  const p = state.progress;
  const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 4;
  return `<div class="loading" aria-live="polite">
    <div class="progress"><div class="bar" id="progress-bar" data-pct="${pct}"></div></div>
    <p id="progress-text">${state.tmdb ? 'Loading from TMDB…' : 'Loading…'}</p>
    <p class="muted small">The first load of a month takes a few seconds. After that it opens instantly from this device.</p></div>`;
}

function rangeTabs(view, anchor) {
  return `<div class="seg" role="tablist" aria-label="Range">${['day', 'week', 'month'].map((v) =>
    `<a role="tab" aria-selected="${v === view}" class="${v === view ? 'on' : ''}" href="#/${v}/${anchor}">${v[0].toUpperCase() + v.slice(1)}</a>`).join('')}</div>`;
}

function myPlatforms() {
  const keys = new Set(PLATFORMS.map((p) => p.key));
  return S.getMyPlatforms().filter((k) => keys.has(k));
}
function visiblePlatforms() {
  const my = myPlatforms();
  return my.length ? PLATFORMS.filter((p) => my.includes(p.key)) : PLATFORMS;
}

function platformChips() {
  const f = S.getFilters();
  const all = !f.platforms.length;
  return `<div class="chips" role="group" aria-label="Platforms">
    <button class="chip ${all ? 'on' : ''}" data-action="chip-all" aria-pressed="${all}">${myPlatforms().length ? 'All my services' : 'All platforms'}</button>
    ${visiblePlatforms().map((p) => {
    const on = f.platforms.includes(p.key);
    return `<button class="chip ${on ? 'on' : ''}" data-action="toggle-platform" data-key="${p.key}" aria-pressed="${on}">${pLogo(p.key)}${esc(p.name)}</button>`;
  }).join('')}</div>`;
}

function filterPanel() {
  const f = S.getFilters();
  const mineSet = myPlatforms().length;
  return `<section class="fsec"><h2 class="label">Platforms</h2>
      <div class="pgrid">${visiblePlatforms().map((p) => {
    const on = f.platforms.includes(p.key);
    return `<button class="pbtn ${on ? 'on' : ''}" data-action="toggle-platform" data-key="${p.key}" aria-pressed="${on}">${pLogo(p.key)}<span class="pname">${esc(p.name)}</span><span class="tick">${on ? '✓' : ''}</span></button>`;
  }).join('')}</div>
      <p class="hint">${mineSet ? `Showing your ${mineSet} services. <a href="#/settings">Change them in Settings</a>.` : 'None selected shows every platform. <a href="#/settings">Pick your services</a> to hide the rest everywhere.'}</p></section>
    <section class="fsec"><h2 class="label">Original language</h2>
      <div class="wrap">${FILTER_LANGS.map((l) => {
    const on = f.languages.includes(l);
    return `<button class="pill ${on ? 'on' : ''}" data-action="toggle-lang" data-key="${l}" aria-pressed="${on}">${esc(langName(l))}</button>`;
  }).join('')}</div></section>
    <section class="fsec switches">
      <label class="switch"><span><strong>Confirmed dates only</strong><small>Hide "Expected" dates from manual entries</small></span>
        <input type="checkbox" data-action="toggle-confirmed" ${f.confirmedOnly ? 'checked' : ''}></label>
      <label class="switch"><span><strong>Every new episode</strong><small>Off shows only new series, premieres and finales in "All"</small></span>
        <input type="checkbox" data-action="toggle-episodes" ${f.episodes ? 'checked' : ''}></label>
    </section>`;
}

const emptyMsg = (t) => `<p class="empty-msg">${esc(t)}</p>`;
const countText = (n) => `${n} ${n === 1 ? 'title' : 'titles'}`;

// ---------------------------------------------------------------- release views
async function renderRange(view, param) {
  const anchor = D.isValid(param) ? param : D.today();
  let from;
  let to;
  if (view === 'day') { from = D.addDays(anchor, -3); to = D.addDays(anchor, 3); }
  else if (view === 'week') { from = D.weekStart(anchor); to = D.addDays(from, 6); }
  else { const mk = D.monthKey(anchor); from = D.monthStart(mk); to = D.monthEnd(mk); }
  const months = D.monthsBetween(from, to);
  const draw = () => {
    const data = collect(months, from, to);
    state.watchKeys = new Set(S.getWatchlist().map((i) => i.key));
    const list = data && applyFilters(data, S.getFilters(), state.watchKeys, myPlatforms());
    const body = view === 'day' ? dayBody(anchor, list) : view === 'week' ? weekBody(anchor, from, list) : monthBody(anchor, list);
    render(page({ nav: 'releases', subtitle: `India · ${D.fmtLong(D.today())}`, body, sidebar: filterPanel(), connect: true }));
    const bar = document.getElementById('progress-bar');
    if (bar) bar.style.width = `${bar.dataset.pct}%`;
    return data;
  };
  if (!draw()) {
    const h = location.hash;
    await Promise.all(months.map(ensureMonth));
    if (location.hash === h) draw();
  }
}

function dayBody(anchor, list) {
  const days = Array.from({ length: 7 }, (_, i) => D.addDays(anchor, i - 3));
  const strip = days.map((d) => {
    const n = list ? list.filter((r) => r.date === d).length : null;
    return `<a class="daypill ${d === anchor ? 'on' : ''} ${isToday(d) ? 'today' : ''}" href="#/day/${d}"
      aria-label="${esc(D.fmtLong(d))}${n == null ? '' : `, ${n} releases`}" ${d === anchor ? 'aria-current="date"' : ''}>
      <span class="dow">${esc(D.fmtDow(d))}</span><span class="dnum">${D.dayNum(d)}</span>
      <span class="dcount">${n == null ? '·' : `${n} new`}</span></a>`;
  }).join('');
  const next = D.addDays(anchor, 1);
  const sec = (title, date) => {
    const items = list.filter((r) => r.date === date);
    return `<section class="sec"><div class="sec-head"><h2>${esc(title)}</h2><span class="muted small">${countText(items.length)}</span></div>
      ${items.length ? listOrTiles(items, 'lg') : emptyMsg(emptyFor('on this day'))}</section>`;
  };
  const head1 = isToday(anchor) ? 'Streaming today' : D.fmtLong(anchor);
  const head2 = isToday(anchor) ? `Tomorrow · ${D.fmtShort(next)}` : D.fmtLong(next);
  return `${rangeTabs('day', anchor)}
    <div class="daystrip">
      <a class="iconbtn ghost" href="#/day/${D.addDays(anchor, -7)}" aria-label="Previous week">${icon.left}</a>
      ${strip}
      <a class="iconbtn ghost" href="#/day/${D.addDays(anchor, 7)}" aria-label="Next week">${icon.right}</a>
    </div>
    ${isToday(anchor) ? '' : `<p class="center"><a href="#/day/${D.today()}">Back to today</a></p>`}
    ${kindTabs(true)}
    <div class="mobile-only">${platformChips()}</div>
    ${list ? sec(head1, anchor) + sec(head2, next) : loadingBlock()}`;
}

function weekBody(anchor, from, list) {
  const to = D.addDays(from, 6);
  const thisWeek = D.weekStart(D.today()) === from;
  let groups = '';
  if (list) {
    groups = Array.from({ length: 7 }, (_, i) => D.addDays(from, i)).map((d) => {
      const items = list.filter((r) => r.date === d);
      return `<section class="day-group ${items.length ? '' : 'empty'} ${isToday(d) ? 'is-today' : ''}">
        <div class="day-head"><span class="dh-day">${esc(D.fmtShort(d))}${isToday(d) ? ' · Today' : ''}</span><span class="dh-line"></span><span class="muted small">${countText(items.length)}</span></div>
        ${items.length ? listOrTiles(items, 'sm') : '<p class="muted small none">No releases</p>'}</section>`;
    }).join('');
  }
  return `${rangeTabs('week', anchor)}
    <div class="rangenav">
      <a class="iconbtn ghost" href="#/week/${D.addDays(from, -7)}" aria-label="Previous week">${icon.left}</a>
      <div class="rn-title"><h1>${esc(D.fmtRange(from, to))}</h1>
      <span class="muted small">${thisWeek ? 'This week' : `<a href="#/week/${D.today()}">Back to this week</a>`}${list ? ` · ${countText(list.length)}` : ''}</span></div>
      <a class="iconbtn ghost" href="#/week/${D.addDays(from, 7)}" aria-label="Next week">${icon.right}</a>
    </div>
    ${kindTabs(true)}
    ${list ? (list.length ? `<div class="week-groups">${groups}</div>` : emptyMsg(emptyFor('this week'))) : loadingBlock()}`;
}

function monthBody(anchor, list) {
  const mk = D.monthKey(anchor);
  const start = D.monthStart(mk);
  const end = D.monthEnd(mk);
  const lead = (D.parse(start).getDay() + 6) % 7;
  const cells = [];
  for (let i = lead; i > 0; i--) cells.push(`<span class="cal-cell out" aria-hidden="true">${D.dayNum(D.addDays(start, -i))}</span>`);
  for (let d = start; d <= end; d = D.addDays(d, 1)) {
    const items = list ? list.filter((r) => r.date === d) : [];
    const keys = [...new Set(items.flatMap((r) => r.platforms))].slice(0, 3);
    const mine = items.some((r) => state.watchKeys.has(r.key));
    const thumbs = items.slice(0, 3).map((r) => {
      const src = img(r.poster, 'w92');
      return src ? `<img src="${src}" alt="" loading="lazy">` : `<span class="thumb-ph ${tintClass(r.title)}"></span>`;
    }).join('');
    cells.push(`<a class="cal-cell ${d === anchor ? 'on' : ''} ${isToday(d) ? 'today' : ''} ${mine ? 'has-mine' : ''}" href="#/month/${d}"
      aria-label="${esc(D.fmtLong(d))}, ${items.length} releases${mine ? ', includes your watchlist' : ''}" ${d === anchor ? 'aria-current="date"' : ''}>
      <span class="cal-d">${D.dayNum(d)}</span><span class="dots">${keys.map((k) => `<span class="mdot p-${k}"></span>`).join('')}</span>
      <span class="thumbs" aria-hidden="true">${thumbs}${items.length > 3 ? `<span class="more">+${items.length - 3}</span>` : ''}</span>
      ${items.length ? `<span class="cal-n">${items.length}</span>` : ''}</a>`);
  }
  const sel = list ? list.filter((r) => r.date === anchor) : [];
  const dow = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  return `${rangeTabs('month', anchor)}
    <div class="rangenav">
      <a class="iconbtn ghost" href="#/month/${D.addMonths(mk, -1)}-01" aria-label="Previous month">${icon.left}</a>
      <div class="rn-title"><h1>${esc(D.fmtMonth(mk))}</h1>${list ? `<span class="muted small">${countText(list.length)}</span>` : ''}</div>
      <a class="iconbtn ghost" href="#/month/${D.addMonths(mk, 1)}-01" aria-label="Next month">${icon.right}</a>
    </div>
    ${kindTabs(false)}
    <div class="month-wrap">
      <div class="cal-box">
        <div class="cal-head" aria-hidden="true">${dow.map((x) => `<span>${x}</span>`).join('')}</div>
        <div class="cal">${cells.join('')}</div>
      </div>
      <div class="month-list">
        ${list ? `<div class="sec-head"><h2>${esc(D.fmtShort(anchor))}${isToday(anchor) ? ' · Today' : ''}</h2><span class="muted small">${countText(sel.length)}</span></div>
        ${sel.length ? `<div class="rows">${sel.map(cardSm).join('')}</div>` : emptyMsg(emptyFor('on this day'))}` : loadingBlock()}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- title detail
async function titleDetail(type, id) {
  const ck = `d:${type}:${id}`;
  const c = S.cacheGet(ck);
  if (c) return c;
  await ensureProviders();
  const d = await state.tmdb.get(`/${type}/${id}`, {
    append_to_response: type === 'movie' ? 'watch/providers,release_dates,credits' : 'watch/providers,credits',
  });
  const inRel = type === 'movie' ? (d.release_dates?.results || []).find((r) => r.iso_3166_1 === 'IN') : null;
  const wp = d['watch/providers']?.results?.IN || {};
  const rd = inRel?.release_dates || [];
  const v = {
    id: d.id, type,
    title: d.title || d.name || 'Untitled',
    year: String(d.release_date || d.first_air_date || '').slice(0, 4),
    runtime: d.runtime || (d.episode_run_time || [])[0] || 0,
    genres: (d.genres || []).map((g) => g.name),
    overview: d.overview || '',
    poster: d.poster_path || '', backdrop: d.backdrop_path || '',
    lang: d.original_language || '',
    spoken: (d.spoken_languages || []).map((l) => l.english_name || l.name).filter(Boolean),
    seasons: d.number_of_seasons || 0,
    cert: rd.find((r) => r.certification)?.certification || '',
    theatrical: rd.filter((r) => r.type === 2 || r.type === 3).map((r) => r.release_date.slice(0, 10)).sort()[0] || '',
    digital: rd.filter((r) => r.type === 4).map((r) => r.release_date.slice(0, 10)).sort(),
    providers: [...new Set([...(wp.flatrate || []), ...(wp.free || []), ...(wp.ads || [])]
      .map((p) => state.providers?.ids?.[p.provider_id] || keyForText(p.provider_name)).filter(Boolean))],
    link: /^https:\/\/www\.themoviedb\.org\//.test(wp.link || '') ? wp.link : '',
    cast: (d.credits?.cast || []).slice(0, 12).map((c) => ({ name: c.name, character: c.character || '', profile: c.profile_path || '' })),
  };
  S.cacheSet(ck, v, 24 * H);
  return v;
}

async function renderTitle(type, id) {
  if (!['movie', 'tv'].includes(type) || !/^\d+$/.test(id || '')) return renderNotFound();
  if (!state.tmdb) {
    render(page({ nav: 'releases', body: `<div class="banner info"><strong>Connect TMDB to see title details.</strong> <a href="#/settings">Connect now</a></div>` }));
    return;
  }
  render(page({ nav: 'releases', body: '<div class="loading"><p>Loading title…</p></div>' }));
  const h = location.hash;
  let t;
  try {
    t = await titleDetail(type, id);
  } catch (e) {
    if (location.hash !== h) return;
    if (e.kind === 'auth') state.authError = true;
    render(page({ nav: 'releases', body: `<div class="banner bad">${esc(e.message)}</div><p><a href="#/">Back to releases</a></p>` }));
    return;
  }
  if (location.hash !== h) return;
  const key = `${type}:${id}`;
  const rel = findRelease(key);
  const date = rel?.date || (t.digital.length ? t.digital[t.digital.length - 1] : '');
  const platforms = rel?.platforms?.length ? rel.platforms : t.providers;
  const saved = S.inWatchlist(key);
  const meta = [type === 'movie' ? 'Movie' : `Series${t.seasons ? ` · ${t.seasons} season${t.seasons > 1 ? 's' : ''}` : ''}`,
    t.year, t.runtime ? fmtRuntime(t.runtime) : '', t.genres.slice(0, 2).join(', '), t.cert].filter(Boolean).join(' · ');

  let when;
  if (date) {
    const past = date <= D.today();
    when = `<span class="when">${past ? 'Streaming since' : 'Streaming from'} <strong>${esc(D.fmtLong(date))}</strong>${rel && rel.kind !== 'movie' && rel.label ? ` · ${esc(rel.label)}` : ''}</span>`;
  } else if (platforms.length) {
    when = '<span class="when">Streaming now in India</span>';
  } else {
    when = '<span class="when muted">No India streaming date on TMDB yet.</span>';
  }
  const gap = type === 'movie' && t.theatrical && date && D.daysBetween(t.theatrical, date) > 0
    ? `<span class="muted small">In theatres ${esc(D.fmtDate(t.theatrical))} · came to OTT ${D.daysBetween(t.theatrical, date)} days later</span>` : '';
  const source = rel
    ? `<span class="muted small">Date source: ${rel.source === 'Manual' ? 'manual entry' : 'TMDB'}${rel.sourceUrl ? ` · <a href="${esc(rel.sourceUrl)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}${rel.conflict ? ` · TMDB says ${esc(D.fmtDate(rel.conflict))}` : ''}</span>` : '';
  const backdrop = img(t.backdrop, 'w780');

  const body = `<article class="detail">
    <div class="hero ${tintClass(t.title)}">
      ${backdrop ? `<img class="backdrop" src="${backdrop}" alt="">` : ''}
      <a class="iconbtn hero-back" href="#/" aria-label="Back to releases">${icon.left}</a>
      <div class="hero-poster">${posterBox(t, 'w342')}</div>
    </div>
    <div class="detail-body">
      <div><h1 class="dtitle">${esc(t.title)}</h1><p class="muted">${esc(meta)}</p></div>
      <div class="plat-card">
        <div class="pc-top"><span class="pc-plats">${platforms.length ? platforms.map(pTag).join('') : '<span class="muted">Platform not listed yet</span>'}</span>${rel ? statusTag(rel) : ''}</div>
        ${when}${gap}${source}
      </div>
      <div class="btnrow">
        <button class="btn ${saved ? 'btn-ghost on' : 'btn-primary'}" data-action="toggle-watch" data-key="${esc(key)}" aria-pressed="${saved}">${icon.bookmarkSm}${saved ? 'In watchlist' : 'Add to watchlist'}</button>
        ${date ? `<button class="btn btn-ghost" data-action="export-one">${icon.calAdd}Add to calendar</button>` : ''}
        ${t.link ? `<a class="btn btn-ghost" href="${esc(t.link)}" target="_blank" rel="noopener noreferrer">Where to watch ${icon.ext}</a>` : ''}
      </div>
      ${t.spoken.length ? `<section class="dsec"><h2 class="label">Audio</h2><div class="wrap">${t.spoken.map((l) => `<span class="pill static">${esc(l)}</span>`).join('')}</div></section>` : ''}
      ${t.overview ? `<section class="dsec"><h2 class="label">Story</h2><p class="story">${esc(t.overview)}</p></section>` : ''}
      ${t.cast.length ? `<section class="dsec"><h2 class="label">Cast</h2><div class="cast">${t.cast.map((c) => {
    const src = img(c.profile, 'w185');
    return `<div class="castp">${src ? `<img src="${src}" alt="" loading="lazy">` : '<span class="cast-ph" aria-hidden="true"></span>'}<span>${esc(c.name)}</span></div>`;
  }).join('')}</div></section>` : ''}
      <p><a href="#/admin?prefill=${esc(key)}">Wrong date or platform? Fix it</a></p>
    </div></article>`;
  render(page({ nav: 'releases', body }));
  state.detailCache = { key, t, rel, date, platforms };
}

// ---------------------------------------------------------------- filters sheet
function renderFilters(query) {
  const back = safeBack(query.get('back'));
  const n = countForBack(back);
  render(`<div class="sheet-page"><div class="sheet" role="dialog" aria-label="Filters">
    <div class="sheet-head"><h1>Filters</h1><a class="iconbtn ghost" href="${esc(back)}" aria-label="Close filters">${icon.close}</a></div>
    <div class="sheet-body">${filterPanel()}</div>
    <div class="sheet-foot"><button class="btn btn-ghost" data-action="reset-filters">Reset</button>
      <a class="btn btn-primary grow" href="${esc(back)}">${n == null ? 'Show releases' : `Show ${n} releases`}</a></div>
  </div></div>`);
}
function safeBack(b) {
  return typeof b === 'string' && /^#\/(day|week|month)?(\/\d{4}-\d{2}-\d{2})?$/.test(b) ? b : '#/';
}
function countForBack(back) {
  const m = back.match(/^#\/(day|week|month)?\/?(\d{4}-\d{2}-\d{2})?$/);
  const view = m?.[1] || 'day';
  const anchor = m?.[2] || D.today();
  let from = anchor; let to = anchor;
  if (view === 'week') { from = D.weekStart(anchor); to = D.addDays(from, 6); }
  if (view === 'month') { from = D.monthStart(D.monthKey(anchor)); to = D.monthEnd(D.monthKey(anchor)); }
  const data = collect(D.monthsBetween(from, to), from, to);
  return data ? applyFilters(data, S.getFilters(), new Set(S.getWatchlist().map((i) => i.key)), myPlatforms()).length : null;
}

// ---------------------------------------------------------------- watchlist
function whenLabel(item) {
  const t = D.today();
  if (!item.date) return ['Date not announced', 'muted'];
  if (item.date === t) return ['Out today', 'ok'];
  if (item.date < t) return ['Streaming now', 'ok'];
  const n = D.daysBetween(t, item.date);
  const s = n === 1 ? 'Tomorrow' : `In ${n} days`;
  return [item.status === 'Expected' ? `${s} · expected` : s, 'warn'];
}

function renderWatchlist() {
  const w = S.getWatchlist();
  const t = D.today();
  const now = w.filter((i) => i.date && i.date <= t).sort((a, b) => (a.date < b.date ? 1 : -1));
  const soon = w.filter((i) => i.date && i.date > t).sort((a, b) => (a.date < b.date ? -1 : 1));
  const none = w.filter((i) => !i.date);
  const row = (i) => {
    const [label, cls] = whenLabel(i);
    const r = { ...i, platforms: i.platforms || [] };
    return `<div class="wrow"><a class="row" href="${titleHref(r)}">${posterBox(r, 'w92')}
      <div class="row-body"><span class="row-title">${esc(i.title)}</span>
      <span class="row-meta">${r.platforms.slice(0, 2).map(pTag).join('') || esc(i.mediaType === 'tv' ? 'Series' : 'Movie')}</span></div>
      <span class="when-tag ${cls}">${esc(label)}</span></a>
      <button class="iconbtn ghost" data-action="unwatch" data-key="${esc(i.key)}" aria-label="Remove ${esc(i.title)} from watchlist">${icon.trash}</button></div>`;
  };
  const group = (title, items) => (items.length ? `<section class="sec"><h2 class="label">${title}</h2><div class="rows">${items.map(row).join('')}</div></section>` : '');

  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  const reminder = `<div class="reminder">
    <span class="rem-icon">${icon.bell}</span>
    <div class="rem-body"><strong>Reminders on release day</strong>
      <span class="small">${perm === 'granted' ? 'On. You get a notification when you open OTT Radar on the day something you saved comes out.'
    : perm === 'denied' ? 'Notifications are blocked for this site in your browser settings.'
      : supported ? 'Get a notification when you open OTT Radar on release day.'
        : 'This browser cannot show notifications. On iPhone, add OTT Radar to your Home Screen first, then open it from there.'}</span>
      ${perm === 'default' ? '<button class="btn btn-primary small" data-action="enable-reminders">Turn on reminders</button>' : ''}
    </div></div>`;

  const dated = w.filter((i) => i.date).length;
  const exportBox = w.length ? `<div class="export">
    <button class="btn btn-ghost small" data-action="export-ics" ${dated ? '' : 'disabled'}>${icon.calAdd}Add to my calendar</button>
    <span class="small muted">Downloads a calendar file (.ics) with ${dated} dated ${dated === 1 ? 'title' : 'titles'} for Google, Apple or Outlook Calendar. It's a one-time import, so download it again when dates change.</span></div>` : '';
  const body = `<div class="page-head"><h1>Watchlist</h1><p class="muted small">Saved on this device · no login needed</p></div>
    ${reminder}${exportBox}
    ${w.length ? group('Streaming now', now) + group('Coming soon', soon) + group('No date yet', none)
    : emptyMsg('Nothing saved yet. Open any title and tap "Add to watchlist".')}`;
  render(page({ nav: 'watchlist', body, actions: false }));
}

async function checkReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const t = D.today();
  const notified = S.getNotified();
  const due = S.getWatchlist().filter((i) => i.date === t && !notified.includes(`${i.key}:${t}`));
  for (const i of due) {
    const names = (i.platforms || []).map((k) => platformByKey(k)?.name).filter(Boolean).join(', ');
    const body = `${i.title} is streaming today${names ? ` on ${names}` : ''}.`;
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification('OTT Radar', { body, icon: '/icons/icon-192.png', tag: i.key, data: { url: `/${titleHref(i)}` } });
      else new Notification('OTT Radar', { body, icon: '/icons/icon-192.png' });
    } catch { /* ignore */ }
    notified.push(`${i.key}:${t}`);
  }
  if (due.length) S.setNotified(notified.slice(-300));
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  const my = myPlatforms();
  if (state.tmdb && !state.providers && !state.authError && !state.loadingLogos) {
    // Load the official logos for the service picker, then redraw.
    state.loadingLogos = true;
    ensureProviders().then(() => { if (location.hash.startsWith('#/settings')) rerender(); }).catch(() => {}).finally(() => { state.loadingLogos = false; });
  }
  const tok = S.getToken();
  const admin = S.getAdminToken();
  const editing = state.editToken || !tok;
  const last = S.getLastFetch();
  const lastText = last ? new Date(last).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not yet';
  const status = tok && !state.authError ? ['Connected', 'ok'] : tok ? ['Token rejected', 'bad'] : ['Not connected', 'bad'];

  const form = `<form class="stack" data-form="token" autocomplete="off">
      ${!tok ? `<p class="small">OTT Radar loads release dates and the platforms' official logos from TMDB using <strong>your own free TMDB token</strong>.</p>
      <ol class="steps small">
        <li>Create a free account at <a href="https://www.themoviedb.org/signup" target="_blank" rel="noopener noreferrer">themoviedb.org</a></li>
        <li>Open <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">Settings → API</a> and request a key for personal use</li>
        <li>Copy the <strong>API Read Access Token</strong> (or the API Key) and paste it below</li>
      </ol>` : ''}
      <label class="field"><span>API Read Access Token or API Key</span>
        <input name="token" type="password" required minlength="20" maxlength="400" spellcheck="false" autocapitalize="off" placeholder="eyJhbGciOi…"></label>
      ${state.tokenError ? `<p class="error" role="alert">${esc(state.tokenError)}</p>` : ''}
      <div class="btnrow"><button class="btn btn-primary grow" type="submit">Test and save</button>
      ${tok ? '<button class="btn btn-ghost" type="button" data-action="cancel-token">Cancel</button>' : ''}</div>
    </form>`;
  const connected = `<div class="stack">
      <div class="small"><div>Token ending <code>••••${esc(tok.slice(-4))}</code></div><div class="muted">Last fetch: ${esc(lastText)} · region India</div></div>
      <div class="btnrow"><button class="btn btn-ghost grow" data-action="replace-token">Replace token</button>
      <button class="btn btn-danger grow" data-action="remove-token">Remove token</button></div></div>`;

  const body = `<div class="page-head"><h1>Settings</h1><p class="muted small">Everything here stays on this device</p></div>
    <section class="panel">
      <div class="panel-head"><h2>TMDB connection</h2><span class="status ${status[1]}">${status[0]}</span></div>
      ${editing ? form : connected}
      <div class="note">${icon.lock}<span class="small">Your token is saved only in this browser and sent only to api.themoviedb.org. OTT Radar's server never sees it. Clearing your browser data removes it.</span></div>
    </section>
    <section class="panel" id="my-services">
      <div class="panel-head"><h2>My streaming services</h2><span class="muted small">${my.length ? `${my.length} of ${PLATFORMS.length} selected` : 'All services shown'}</span></div>
      <p class="small muted">Only releases on the services you tick appear anywhere in OTT Radar. Leave everything unticked to see all of them.</p>
      <div class="pgrid">${PLATFORMS.map((p) => {
    const on = my.includes(p.key);
    return `<button class="pbtn ${on ? 'on' : ''}" data-action="toggle-my" data-key="${p.key}" aria-pressed="${on}">${pLogo(p.key)}<span class="pname">${esc(p.name)}</span><span class="tick">${on ? '✓' : ''}</span></button>`;
  }).join('')}</div>
      ${my.length ? '<button class="btn btn-ghost small" data-action="my-clear">Show all services again</button>' : ''}
    </section>
    <section class="panel links">
      <a href="#/filters?back=%23%2F">Filters and languages <span class="muted">›</span></a>
      <a href="#/watchlist">Watchlist and reminders <span class="muted">›</span></a>
      <button class="linkrow" data-action="clear-cache">Refresh all data from TMDB <span class="muted">›</span></button>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Owner tools</h2>${admin ? '<span class="status ok">Unlocked</span>' : ''}</div>
      <p class="small muted">Only the site owner has the admin token. It lets you add release dates TMDB doesn't have yet. Everyone else can ignore this.</p>
      ${admin ? `<div class="btnrow"><a class="btn btn-primary grow" href="#/admin">Add a release manually</a><button class="btn btn-ghost" data-action="remove-admin">Lock</button></div>`
    : `<form class="row-form" data-form="admin-token" autocomplete="off"><label class="field grow"><span>Admin token</span><input name="admin" type="password" required minlength="8" maxlength="200"></label><button class="btn btn-ghost" type="submit">Unlock</button></form>`}
    </section>
    <p class="attribution small muted">Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer">TMDB</a>. This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability data is provided by JustWatch through TMDB.</p>`;
  render(page({ nav: 'settings', body, actions: false }));
}

// ---------------------------------------------------------------- search
async function renderSearch(query) {
  const q = (query.get('q') || '').trim().slice(0, 100);
  const s = state.search;
  const form = `<form class="row-form" data-form="search" role="search"><label class="field grow"><span class="sr-only">Search movies and series</span>
    <input name="q" type="search" value="${esc(q)}" placeholder="Search movies and series" autofocus></label><button class="btn btn-primary" type="submit">Search</button></form>`;
  const draw = () => {
    let res = '';
    if (!state.tmdb) res = `<div class="banner info"><strong>Connect TMDB to search.</strong> <a href="#/settings">Connect now</a></div>`;
    else if (!q) res = emptyMsg('Type a title to search TMDB.');
    else if (s.q !== q || !s.results) res = '<div class="loading"><p>Searching…</p></div>';
    else if (s.error) res = `<div class="banner bad">${esc(s.error)}</div>`;
    else if (!s.results.length) res = emptyMsg('No matches.');
    else res = `<div class="rows">${s.results.map(cardSm).join('')}</div>`;
    render(page({ nav: 'releases', body: `<div class="page-head"><h1>Search</h1></div>${form}${res}` }));
  };
  draw();
  if (state.tmdb && q && (s.q !== q || !s.results)) {
    const h = location.hash;
    Object.assign(s, { q, results: null, error: '' });
    try {
      s.results = await searchTitles(q);
    } catch (e) {
      s.results = [];
      s.error = e.message;
    }
    if (location.hash === h) draw();
  }
}

async function searchTitles(q) {
  const r = await state.tmdb.get('/search/multi', { query: q, include_adult: false, region: 'IN' });
  return (r.results || []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 20).map((x) => ({
    key: `${x.media_type}:${x.id}`, mediaType: x.media_type, tmdbId: x.id, title: x.title || x.name || 'Untitled',
    lang: x.original_language || '', poster: x.poster_path || '', platforms: [], genres: [],
    label: String(x.release_date || x.first_air_date || '').slice(0, 4), kind: x.media_type === 'tv' ? 'series' : 'movie',
    year: String(x.release_date || x.first_air_date || '').slice(0, 4),
  }));
}

// ---------------------------------------------------------------- admin (owner only)
async function adminFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${S.getAdminToken()}`, ...(opts.headers || {}) },
  });
  let j = {};
  try { j = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const msg = {
      unauthorized: 'The admin token is wrong. Check it in Settings.',
      admin_not_configured: 'ADMIN_TOKEN is not set on Cloudflare yet (see README).',
      db_not_configured: 'The D1 database is not connected yet (see README).',
    }[j.error] || `Request failed (${res.status}${j.error ? `: ${j.error}` : ''}).`;
    throw new Error(msg);
  }
  return j;
}

async function loadAdminList() {
  const from = D.addDays(D.today(), -30);
  const to = D.addDays(D.today(), 400);
  try {
    const res = await fetch(`/api/manual?from=${from}&to=${to}`);
    const j = await res.json();
    state.admin.list = j.entries || [];
  } catch {
    state.admin.list = [];
  }
}

async function renderAdmin(query) {
  const a = state.admin;
  if (!S.getAdminToken()) {
    render(page({ nav: 'settings', actions: false, body: `<div class="page-head"><h1>Add a release</h1></div>
      <div class="banner info">This screen is for the site owner. Unlock it with the admin token in <a href="#/settings">Settings</a>.</div>` }));
    return;
  }
  const prefill = query.get('prefill') || '';
  if (prefill && a.prefilled !== prefill && /^(movie|tv):\d+$/.test(prefill) && state.tmdb) {
    a.prefilled = prefill;
    const [type, id] = prefill.split(':');
    try {
      const t = await titleDetail(type, id);
      a.sel = { tmdbId: t.id, mediaType: type, title: t.title, poster: t.poster, lang: t.lang, year: t.year, platform: t.providers[0] || '' };
    } catch { /* ignore */ }
  }
  if (!a.list) await loadAdminList();

  const sel = a.sel;
  const results = a.results
    ? `<div class="results">${a.results.length ? a.results.map((r, i) => `<button type="button" class="result ${sel && sel.tmdbId === r.tmdbId && sel.mediaType === r.mediaType ? 'on' : ''}" data-action="pick-result" data-i="${i}">
        ${posterBox(r, 'w92')}<span class="row-body"><span class="row-title">${esc(r.title)}</span><span class="row-meta">${r.mediaType === 'tv' ? 'Series' : 'Movie'} · ${esc(langName(r.lang))}${r.year ? ` · ${esc(r.year)}` : ''}</span></span></button>`).join('') : emptyMsg('No matches on TMDB.')}</div>`
    : '';
  const today7 = D.addDays(D.today(), 7);
  const form = sel ? `<form class="stack panel" data-form="manual">
      <div class="sel-title">${posterBox(sel, 'w92')}<div><strong>${esc(sel.title)}</strong><div class="muted small">${sel.mediaType === 'tv' ? 'Series' : 'Movie'}${sel.year ? ` · ${esc(sel.year)}` : ''}</div></div></div>
      <div class="grid2">
        <label class="field"><span>Platform</span><select name="platform" required>${PLATFORMS.map((p) => `<option value="${p.key}" ${sel.platform === p.key ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Streaming from</span><input name="date" type="date" required value="${today7}"></label>
      </div>
      <fieldset class="field"><legend>How sure is this date?</legend><div class="seg small">
        ${['Expected', 'Confirmed'].map((s) => `<button type="button" class="${a.status === s ? 'on' : ''}" data-action="set-status" data-key="${s}" aria-pressed="${a.status === s}">${s}</button>`).join('')}</div></fieldset>
      ${sel.mediaType === 'tv' ? '<label class="field"><span>Label <small class="muted">(for example "Season 2")</small></span><input name="label" maxlength="60"></label>' : ''}
      <label class="field"><span>Source link <small class="muted">(news article or official post)</small></span><input name="source" type="url" maxlength="500" placeholder="https://"></label>
      <p class="muted small">If TMDB later shows a different date, the app keeps yours and marks the title "Dates disagree".</p>
      ${a.error ? `<p class="error" role="alert">${esc(a.error)}</p>` : ''}
      <button class="btn btn-primary" type="submit" ${a.busy ? 'disabled' : ''}>${a.busy ? 'Saving…' : 'Save release'}</button>
    </form>` : '';
  const list = (a.list || []).map((m) => `<div class="wrow"><div class="row static">${posterBox({ title: m.title, poster: m.poster_path }, 'w92')}
      <div class="row-body"><span class="row-title">${esc(m.title)}</span><span class="row-meta">${esc(D.fmtDate(m.date))} · ${esc(platformByKey(m.platform)?.name || m.platform)} · ${esc(m.status)}${m.label ? ` · ${esc(m.label)}` : ''}</span></div></div>
      <button class="iconbtn ghost" data-action="delete-manual" data-id="${m.id}" aria-label="Delete ${esc(m.title)}">${icon.trash}</button></div>`).join('');

  const body = `<div class="page-head"><h1>Add a release</h1><p class="muted small">Owner only · saved to the site's database for everyone</p></div>
    ${state.tmdb ? `<form class="row-form" data-form="tmdb-search"><label class="field grow"><span>Find the title on TMDB</span>
      <input name="q" type="search" required maxlength="100" placeholder="Title"></label><button class="btn btn-ghost" type="submit">Find</button></form>`
    : '<div class="banner info">Connect your TMDB token in <a href="#/settings">Settings</a> to search titles.</div>'}
    ${results}${form}
    <section class="sec"><h2 class="label">Your manual entries</h2>${list ? `<div class="rows">${list}</div>` : emptyMsg('None yet.')}</section>`;
  render(page({ nav: 'settings', body, actions: false }));
}

function renderNotFound() {
  render(page({ nav: 'releases', body: `<div class="page-head"><h1>Page not found</h1></div><p><a href="#/">Back to releases</a></p>` }));
}

// ---------------------------------------------------------------- router
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = h.split('?');
  return { parts: path.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return ''; } }), query: new URLSearchParams(qs) };
}
function render(html) {
  $app.innerHTML = html;
}
let lastHash = null;
async function route() {
  const { parts, query } = parseHash();
  const same = lastHash === location.hash;
  const y = window.scrollY;
  lastHash = location.hash;
  const v = parts[0] || 'day';
  switch (v) {
    case 'day': case 'week': case 'month': await renderRange(v, parts[1]); break;
    case 'title': await renderTitle(parts[1], parts[2]); break;
    case 'filters': renderFilters(query); break;
    case 'watchlist': renderWatchlist(); break;
    case 'settings': renderSettings(); break;
    case 'search': await renderSearch(query); break;
    case 'admin': await renderAdmin(query); break;
    default: renderNotFound();
  }
  if (same) window.scrollTo(0, y);
}
function rerender() {
  lastHash = location.hash;
  return route();
}

// ---------------------------------------------------------------- actions
const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
function updateFilters(fn) {
  S.setFilters(fn(S.getFilters()));
  rerender();
}
function resetData() {
  state.months.clear();
  state.loading.clear();
  state.providers = null;
  state.authError = false;
  state.netError = '';
}
let toastTimer;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

const actions = {
  'toggle-platform': (el) => updateFilters((f) => ({ ...f, platforms: toggle(f.platforms, el.dataset.key) })),
  'chip-all': () => updateFilters((f) => ({ ...f, platforms: [] })),
  'toggle-lang': (el) => updateFilters((f) => ({ ...f, languages: toggle(f.languages, el.dataset.key) })),
  'toggle-my': (el) => {
    const next = toggle(myPlatforms(), el.dataset.key);
    S.setMyPlatforms(next);
    // Drop quick-filter selections that are no longer visible.
    if (next.length) {
      const f = S.getFilters();
      S.setFilters({ ...f, platforms: f.platforms.filter((k) => next.includes(k)) });
    }
    rerender();
  },
  'my-clear': () => { S.setMyPlatforms([]); toast('Showing all services'); rerender(); },
  'set-kind': (el) => updateFilters((f) => ({ ...f, kind: el.dataset.key })),
  'toggle-mine': () => updateFilters((f) => ({ ...f, mine: !f.mine })),
  'set-layout': (el) => { S.setLayout(el.dataset.key); rerender(); },
  'export-ics': () => {
    const items = S.getWatchlist().filter((i) => i.date);
    if (!items.length) return;
    downloadIcs(buildIcs(items.map(toEvent)), 'ott-radar-watchlist.ics');
    toast(`Calendar file with ${items.length} ${items.length === 1 ? 'title' : 'titles'} downloaded`);
  },
  'export-one': () => {
    const c = state.detailCache;
    if (!c || !c.date) return;
    const item = { key: c.key, mediaType: c.t.type, tmdbId: c.t.id, title: c.t.title, date: c.date, status: c.rel?.status || '', platforms: c.platforms };
    downloadIcs(buildIcs([toEvent(item)]), `${c.t.title.replace(/[^\w-]+/g, '-').slice(0, 40) || 'release'}.ics`);
    toast('Calendar file downloaded');
  },
  'toggle-confirmed': (el) => updateFilters((f) => ({ ...f, confirmedOnly: el.checked })),
  'toggle-episodes': (el) => updateFilters((f) => ({ ...f, episodes: el.checked })),
  'reset-filters': () => updateFilters(() => ({ ...S.DEFAULT_FILTERS })),
  retry: () => { resetData(); rerender(); },
  'toggle-watch': () => {
    const c = state.detailCache;
    if (!c) return;
    const { key, t, rel } = c;
    const added = S.toggleWatch({
      key, mediaType: t.type, tmdbId: t.id, title: t.title, poster: t.poster,
      date: rel?.date || (t.digital.length ? t.digital[t.digital.length - 1] : ''),
      status: rel?.status || '', platforms: rel?.platforms?.length ? rel.platforms : t.providers,
    });
    toast(added ? 'Added to watchlist' : 'Removed from watchlist');
    rerender();
  },
  unwatch: (el) => {
    S.setWatchlist(S.getWatchlist().filter((i) => i.key !== el.dataset.key));
    toast('Removed from watchlist');
    rerender();
  },
  'enable-reminders': async () => {
    try { await Notification.requestPermission(); } catch { /* ignore */ }
    rerender();
    checkReminders();
  },
  'replace-token': () => { state.editToken = true; state.tokenError = ''; rerender(); },
  'cancel-token': () => { state.editToken = false; state.tokenError = ''; rerender(); },
  'remove-token': () => {
    S.clearToken();
    S.clearCache();
    initTmdb();
    resetData();
    toast('Token removed from this device');
    rerender();
  },
  'remove-admin': () => { S.clearAdminToken(); rerender(); },
  'clear-cache': () => {
    S.clearCache();
    resetData();
    toast('Cached data cleared');
    location.hash = '#/';
  },
  'pick-result': (el) => {
    const r = state.admin.results?.[Number(el.dataset.i)];
    if (!r) return;
    state.admin.sel = { tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, poster: r.poster, lang: r.lang, year: r.year, platform: '' };
    state.admin.error = '';
    rerender();
  },
  'set-status': (el) => { state.admin.status = el.dataset.key; rerender(); },
  'delete-manual': async (el) => {
    if (!confirm('Delete this manual entry?')) return;
    try {
      await adminFetch(`/api/manual/${Number(el.dataset.id)}`, { method: 'DELETE' });
      afterManualChange();
      toast('Entry deleted');
    } catch (e) {
      toast(e.message);
    }
    rerender();
  },
};

function toEvent(i) {
  const names = (i.platforms || []).map((k) => platformByKey(k)?.name).filter(Boolean).join(', ');
  return {
    uid: i.key,
    date: i.date,
    summary: `${i.title}${names ? ` · ${names}` : ''}${i.status === 'Expected' ? ' (expected)' : ''}`,
    description: `${i.title} streams in India${names ? ` on ${names}` : ''}${i.status === 'Expected' ? '. The date is expected, not confirmed' : ''}. From OTT Radar.`,
    url: i.tmdbId ? `${location.origin}/#/title/${i.mediaType}/${i.tmdbId}` : location.origin,
  };
}

function afterManualChange() {
  clearManualCache();
  state.months.clear();
  state.admin.list = null;
}

const forms = {
  token: async (form) => {
    const t = form.token.value.trim();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Testing…';
    try {
      await new Tmdb(t).validate();
      S.setToken(t);
      S.clearCache();
      initTmdb();
      resetData();
      state.editToken = false;
      state.tokenError = '';
      toast('Connected to TMDB');
      location.hash = '#/';
    } catch (e) {
      state.tokenError = e.message;
      rerender();
    }
  },
  'admin-token': (form) => {
    S.setAdminToken(form.admin.value.trim());
    toast('Owner tools unlocked on this device');
    rerender();
  },
  search: (form) => {
    location.hash = `#/search?q=${encodeURIComponent(form.q.value.trim())}`;
  },
  'tmdb-search': async (form) => {
    const q = form.q.value.trim();
    if (!q) return;
    try {
      state.admin.results = await searchTitles(q);
    } catch (e) {
      state.admin.results = [];
      toast(e.message);
    }
    rerender();
  },
  manual: async (form) => {
    const a = state.admin;
    const sel = a.sel;
    const body = {
      tmdb_id: sel.tmdbId, media_type: sel.mediaType, title: sel.title, poster_path: sel.poster || null,
      original_language: sel.lang || '', platform: form.platform.value, date: form.date.value,
      status: a.status, label: form.label ? form.label.value.trim() : '', source_url: form.source.value.trim(),
    };
    a.busy = true;
    a.error = '';
    rerender();
    try {
      await adminFetch('/api/manual', { method: 'POST', body: JSON.stringify(body) });
      afterManualChange();
      a.sel = null;
      a.results = null;
      a.busy = false;
      toast('Release saved');
    } catch (e) {
      a.busy = false;
      a.error = e.message;
    }
    rerender();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  if (el.tagName !== 'INPUT') e.preventDefault();
  actions[el.dataset.action](el, e);
});
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form || !forms[form.dataset.form]) return;
  e.preventDefault();
  forms[form.dataset.form](form);
});
window.addEventListener('hashchange', () => {
  route().then(() => { if (lastHash === location.hash) window.scrollTo(0, 0); });
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkReminders();
});

initTmdb();
route();
checkReminders();
if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  navigator.serviceWorker?.register('/sw.js').catch(() => {});
}
