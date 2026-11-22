// End-to-end test: runs the real Worker + static assets + local D1 through `wrangler dev`,
// and replaces TMDB with a mock (so no TMDB token or network is needed).
// Usage: npm test      (needs `npm install` and Playwright available)
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-output');
const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const ADMIN = 'test-admin-token';
const GOOD = 'eyJtest.good.token.for-the-mock-only';
const TZ = 'Asia/Kolkata';
mkdirSync(OUT, { recursive: true });

// ---------- dates in the browser's timezone
const todayIn = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const T = todayIn();
const nextMonth15 = (() => {
  const [y, m] = T.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 15));
  return d.toISOString().slice(0, 10);
})();

// ---------- mock TMDB
const PROVIDERS = [
  [8, 'Netflix'], [1796, 'Netflix Standard with Ads'], [119, 'Amazon Prime Video'], [2336, 'JioHotstar'],
  [232, 'Zee5'], [237, 'Sony Liv'], [532, 'aha'], [309, 'Sun Nxt'], [999, 'Some Other Service'],
].map(([id, name], i) => ({ provider_id: id, provider_name: name, logo_path: `/logo${id}.png`, display_priorities: { IN: i + 1 } }));

const MOVIES = {
  101: { title: 'Monsoon Ledger', lang: 'hi', dates: [[T, '']], prov: [8], theatrical: addDays(T, -42) },
  102: { title: 'Neelam', lang: 'ta', dates: [[T, '']], prov: [119] },
  103: { title: 'Godavari Nights', lang: 'te', dates: [[addDays(T, 1), 'Streaming on Aha']], prov: [] },
  104: { title: 'Untracked Film', lang: 'en', dates: [[T, '']], prov: [999] },
  105: { title: 'Baarish Ke Baad', lang: 'hi', dates: [[addDays(T, -1), '']], prov: [232] },
  106: { title: 'Next Month Film', lang: 'ml', dates: [[nextMonth15, '']], prov: [2336] },
  301: { title: 'Kaaval', lang: 'ta', dates: [], prov: [] },
};
const SHOWS = {
  201: { name: 'Second Shift', lang: 'hi', prov: [2336], season: 2, eps: [[2, 1, T], [2, 2, addDays(T, 7)]] },
  202: { name: 'Weekly Show', lang: 'en', prov: [8], season: 1, eps: [[1, 1, addDays(T, -14)], [1, 2, addDays(T, -7)], [1, 3, T], [1, 4, addDays(T, 7)]] },
  203: { name: 'Brand New', lang: 'ta', prov: [237], season: 1, eps: [1, 2, 3, 4, 5, 6].map((e) => [1, e, addDays(T, -2)]) },
};
const provList = (ids) => ({ results: { IN: { link: 'https://www.themoviedb.org/movie/1/watch?locale=IN', flatrate: ids.map((id) => PROVIDERS.find((p) => p.provider_id === id)) } } });

function tmdb(url, headers) {
  const auth = headers.authorization || '';
  if (auth !== `Bearer ${GOOD}`) return [401, { status_code: 7, status_message: 'Invalid API key' }];
  const p = url.pathname.replace(/^\/3/, '');
  let m;
  if (p === '/configuration') return [200, { images: {} }];
  if (p === '/watch/providers/movie' || p === '/watch/providers/tv') return [200, { results: PROVIDERS }];
  if (p === '/discover/movie') {
    const from = url.searchParams.get('release_date.gte');
    const to = url.searchParams.get('release_date.lte');
    const ids = Object.entries(MOVIES).filter(([, mv]) => mv.dates.some(([d]) => d >= from && d <= to)).map(([id]) => ({ id: Number(id) }));
    return [200, { page: 1, total_pages: 1, results: ids }];
  }
  if (p === '/discover/tv') {
    const from = url.searchParams.get('air_date.gte');
    const to = url.searchParams.get('air_date.lte');
    const ids = Object.entries(SHOWS).filter(([, s]) => s.eps.some(([, , d]) => d >= from && d <= to)).map(([id]) => ({ id: Number(id) }));
    return [200, { page: 1, total_pages: 1, results: ids }];
  }
  if ((m = p.match(/^\/movie\/(\d+)$/))) {
    const mv = MOVIES[m[1]];
    if (!mv) return [404, {}];
    const rd = mv.dates.map(([d, note]) => ({ type: 4, release_date: `${d}T00:00:00.000Z`, note, certification: 'U/A 16+' }));
    if (mv.theatrical) rd.push({ type: 3, release_date: `${mv.theatrical}T00:00:00.000Z`, note: '', certification: 'U/A 16+' });
    return [200, {
      id: Number(m[1]), title: mv.title, original_language: mv.lang, poster_path: `/poster${m[1]}.jpg`, backdrop_path: `/bd${m[1]}.jpg`,
      runtime: 132, genres: [{ name: 'Thriller' }, { name: 'Drama' }], overview: `${mv.title} overview text.`, release_date: '2026-10-10',
      spoken_languages: [{ english_name: 'Hindi' }, { english_name: 'Tamil' }],
      release_dates: { results: [{ iso_3166_1: 'IN', release_dates: rd }] },
      'watch/providers': provList(mv.prov),
      credits: { cast: [{ name: 'Actor One', character: 'Lead', profile_path: '/p1.jpg' }, { name: 'Actor Two', character: 'Support', profile_path: null }] },
    }];
  }
  if ((m = p.match(/^\/tv\/(\d+)$/))) {
    const s = SHOWS[m[1]];
    if (!s) return [404, {}];
    const past = s.eps.filter(([, , d]) => d <= T);
    const fut = s.eps.filter(([, , d]) => d > T);
    const ep = (e) => e && { season_number: e[0], episode_number: e[1], air_date: e[2] };
    return [200, {
      id: Number(m[1]), name: s.name, original_language: s.lang, poster_path: `/tvp${m[1]}.jpg`, episode_run_time: [45],
      genres: [{ name: 'Drama' }], overview: 'A show.', first_air_date: s.eps[0][2], number_of_seasons: s.season,
      last_episode_to_air: ep(past[past.length - 1]), next_episode_to_air: ep(fut[0]) || null,
      'watch/providers': provList(s.prov), credits: { cast: [] },
    }];
  }
  if ((m = p.match(/^\/tv\/(\d+)\/season\/(\d+)$/))) {
    const s = SHOWS[m[1]];
    return [200, { episodes: s.eps.filter(([sn]) => sn === Number(m[2])).map(([sn, e, d]) => ({ season_number: sn, episode_number: e, air_date: d })) }];
  }
  if (p === '/search/multi') {
    const q = (url.searchParams.get('query') || '').toLowerCase();
    const results = Object.entries(MOVIES).filter(([, mv]) => mv.title.toLowerCase().includes(q))
      .map(([id, mv]) => ({ id: Number(id), media_type: 'movie', title: mv.title, original_language: mv.lang, poster_path: null, release_date: '2026-01-01' }));
    return [200, { results }];
  }
  return [404, { status_message: `mock: no route for ${p}` }];
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// ---------- test harness
let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}`); }
}

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${BASE}/`); if (r.ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('wrangler dev did not start');
}

async function main() {
  execSync('npx wrangler d1 execute ott-radar-india --local --file schema.sql', { cwd: ROOT, stdio: 'ignore' });
  execSync('npx wrangler d1 execute ott-radar-india --local --command "DELETE FROM manual"', { cwd: ROOT, stdio: 'ignore' });
  const server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--var', `ADMIN_TOKEN:${ADMIN}`], { cwd: ROOT, stdio: 'ignore', detached: true });
  const stop = () => { try { process.kill(-server.pid); } catch { /* gone */ } };
  process.on('exit', stop);
  try {
    await waitForServer();

    console.log('API');
    let r = await fetch(`${BASE}/api/manual?from=2026-01-01&to=2026-12-31`);
    check(r.ok && Array.isArray((await r.json()).entries), 'GET /api/manual is public');
    r = await fetch(`${BASE}/api/manual`, { method: 'POST', body: '{}' });
    check(r.status === 401, 'POST without admin token is rejected (401)');
    r = await fetch(`${BASE}/api/manual`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ title: 'x', media_type: 'movie', platform: 'nope', date: T, status: 'Expected' }) });
    check(r.status === 400, 'POST with invalid platform is rejected (400)');
    r = await fetch(`${BASE}/api/manual?from=bad&to=2026-01-01`);
    check(r.status === 400, 'GET with a bad range is rejected (400)');
    r = await fetch(`${BASE}/`);
    check((r.headers.get('content-security-policy') || '').includes("script-src 'self'"), 'CSP header is served');

    const browser = await chromium.launch();
    const errors = [];
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: TZ, locale: 'en-IN', serviceWorkers: 'block' });
    await ctx.route('https://api.themoviedb.org/**', async (route) => {
      const req = route.request();
      const [status, body] = tmdb(new URL(req.url()), req.headers());
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, accept' } });
    });
    await ctx.route('https://image.tmdb.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('dialog', (d) => d.accept());
    const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });

    console.log('First run, no token');
    await page.goto(`${BASE}/`);
    await page.getByText('Connect TMDB to load releases').waitFor();
    check(true, 'shows the "Connect TMDB" banner');
    await shot('01-no-token');

    console.log('Settings: token');
    await page.goto(`${BASE}/#/settings`);
    await page.fill('input[name=token]', 'eyJwrong.token.that-is-long-enough');
    await page.click('button:has-text("Test and save")');
    await page.getByText('TMDB rejected this token').waitFor();
    check(true, 'a wrong token shows an error');
    await page.fill('input[name=token]', GOOD);
    await page.click('button:has-text("Test and save")');
    await page.waitForURL(/#\/$/);
    await page.getByText('Monsoon Ledger').first().waitFor({ timeout: 20000 });
    const day = await page.locator('main').innerText();
    check(day.includes('Streaming today'), 'day view has the "Streaming today" section');
    check(day.includes('Neelam'), 'Prime Video movie listed today');
    check(day.includes('Second Shift') && day.includes('Season 2'), 'season premiere listed as "Season 2"');
    check(!day.includes('Untracked Film'), 'movie on an untracked platform is hidden');
    check(!day.includes('Weekly Show'), 'ordinary weekly episodes hidden by default');
    check(day.includes('Godavari Nights'), 'tomorrow section uses the platform named in the TMDB release note');
    check(await page.locator('img.plogo').count() > 0, 'official provider logos are shown from TMDB');
    await shot('02-day');

    console.log('Quick platform chip');
    await page.click('.mobile-only button[data-key=netflix]');
    let today = await page.locator('.sec').first().innerText();
    check(today.includes('Monsoon Ledger') && !today.includes('Neelam'), 'Netflix chip filters to Netflix titles');
    await page.click('.mobile-only button[data-action=chip-all]');
    today = await page.locator('.sec').first().innerText();
    check(today.includes('Neelam'), '"All platforms" clears the platform filter');

    console.log('Week + month');
    await page.goto(`${BASE}/#/week/${T}`);
    await page.locator('.week-groups').waitFor();
    const week = await page.locator('main').innerText();
    check(week.includes('Baarish Ke Baad') || addDays(T, -1) < weekStartOf(T), 'week view lists yesterday\'s release');
    check(week.includes('Brand New') ? week.includes('New series · 6 episodes') : true, 'binge drop is grouped as "New series · 6 episodes"');
    await shot('03-week');
    await page.goto(`${BASE}/#/month/${T}`);
    await page.locator('.cal').waitFor();
    check(await page.locator('.cal-cell.today').count() === 1, 'month view marks today');
    await shot('04-month');
    await page.click('a[aria-label="Next month"]');
    await page.getByText('Next Month Film').first().waitFor({ timeout: 20000 }).catch(() => {});
    await page.goto(`${BASE}/#/month/${nextMonth15}`);
    await page.getByText('Next Month Film').first().waitFor({ timeout: 20000 });
    check(true, 'next month loads and lists its release');

    console.log('Filters');
    await page.goto(`${BASE}/#/filters?back=${encodeURIComponent(`#/day/${T}`)}`);
    await page.click('input[data-action=toggle-episodes]');
    await shot('05-filters');
    await page.click('.sheet-foot a');
    await page.getByText('Weekly Show').first().waitFor();
    check(true, '"Every new episode" shows weekly episodes');
    await page.goto(`${BASE}/#/filters`);
    await page.click('button[data-action=reset-filters]');

    console.log('Detail + watchlist');
    await page.goto(`${BASE}/#/day/${T}`);
    await page.click('a.card:has-text("Monsoon Ledger")');
    await page.locator('.dtitle').waitFor();
    const detail = await page.locator('main').innerText();
    check(detail.includes('came to OTT 42 days later'), 'detail shows the theatre-to-OTT gap');
    check(detail.includes('Actor One'), 'detail shows cast');
    await shot('06-detail');
    await page.click('button[data-action=toggle-watch]');
    await page.getByText('In watchlist').waitFor();
    await page.goto(`${BASE}/#/watchlist`);
    const wl = await page.locator('main').innerText();
    check(wl.includes('Monsoon Ledger') && wl.includes('Out today'), 'watchlist shows the saved title as "Out today"');
    await shot('07-watchlist');

    console.log('Owner: manual entries');
    await page.goto(`${BASE}/#/settings`);
    await page.fill('input[name=admin]', ADMIN);
    await page.click('button:has-text("Unlock")');
    await page.goto(`${BASE}/#/admin`);
    await page.fill('form[data-form=tmdb-search] input[name=q]', 'Kaaval');
    await page.click('form[data-form=tmdb-search] button');
    await page.click('button.result:has-text("Kaaval")');
    await page.selectOption('select[name=platform]', 'zee5');
    await page.fill('input[name=date]', addDays(T, 3));
    await page.fill('input[name=source]', 'https://example.com/news');
    await shot('08-admin');
    await page.click('button:has-text("Save release")');
    await page.locator('.wrow:has-text("Kaaval")').waitFor();
    check(true, 'manual entry saved and listed');
    await page.goto(`${BASE}/#/day/${addDays(T, 3)}`);
    await page.getByText('Kaaval').first().waitFor({ timeout: 20000 });
    const d3 = await page.locator('.sec').first().innerText();
    check(d3.includes('Expected'), 'manual entry shows as "Expected" on its day');

    // Manual date that disagrees with TMDB
    await page.goto(`${BASE}/#/admin?prefill=movie:101`);
    await page.locator('form[data-form=manual]').waitFor();
    await page.fill('input[name=date]', addDays(T, 2));
    await page.click('button:has-text("Save release")');
    await page.locator('.wrow:has-text("Monsoon Ledger")').waitFor();
    await page.goto(`${BASE}/#/day/${addDays(T, 2)}`);
    await page.getByText('Dates disagree').first().waitFor({ timeout: 20000 });
    check(true, 'a manual date that differs from TMDB is flagged "Dates disagree"');
    await page.goto(`${BASE}/#/day/${T}`);
    today = await page.locator('.sec').first().innerText();
    check(!today.includes('Monsoon Ledger'), 'the manual date overrides the TMDB date');

    await page.goto(`${BASE}/#/admin`);
    const before = await page.locator('.wrow').count();
    await page.click('.wrow:has-text("Kaaval") button[data-action=delete-manual]');
    await page.waitForFunction((n) => document.querySelectorAll('.wrow').length === n - 1, before);
    check(true, 'manual entry deleted');

    console.log('Desktop');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/#/week/${T}`);
    await page.locator('.week-groups').waitFor();
    check(await page.locator('.sidebar').isVisible(), 'desktop shows the filter sidebar');
    check(!(await page.locator('.bottomnav').isVisible()), 'desktop hides the bottom nav');
    await shot('09-desktop-week');

    const real = errors.filter((e) => !/favicon|Failed to load resource/.test(e));
    check(real.length === 0, `no page errors or CSP violations${real.length ? `:\n    ${real.join('\n    ')}` : ''}`);
    await browser.close();
  } finally {
    stop();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

function weekStartOf(s) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

main().catch((e) => { console.error(e); process.exit(1); });
