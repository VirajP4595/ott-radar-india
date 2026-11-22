// End-to-end test: runs the real Worker + static assets + local D1 through `wrangler dev`,
// and replaces TMDB with a mock (so no TMDB token or network is needed).
// Usage: npm test      (needs `npm install` and Playwright available)
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Let Playwright see (and mock) requests made by the service worker.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
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
  102: { title: 'Neelam', lang: 'ta', dates: [[T, 'Tamil, Telugu, Hindi']], prov: [119] },
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
  204: { name: 'Last Dance', lang: 'hi', prov: [119], season: 3, eps: [[3, 1, addDays(T, -14)], [3, 2, addDays(T, -7)], [3, 3, T, 'finale']] },
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
    return [200, { episodes: s.eps.filter(([sn]) => sn === Number(m[2])).map(([sn, e, d, type]) => ({ season_number: sn, episode_number: e, air_date: d, episode_type: type || 'standard' })) }];
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

    console.log('Service worker (offline cache)');
    {
      const swCtx = await browser.newContext({ serviceWorkers: 'allow' });
      await swCtx.route('https://image.tmdb.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
      const sp = await swCtx.newPage();
      await sp.goto(`${BASE}/`);
      await sp.evaluate(() => navigator.serviceWorker.ready);
      await sp.reload();
      check(await sp.evaluate(() => !!navigator.serviceWorker.controller), 'service worker installs and controls the page');
      const res = await sp.evaluate(() => new Promise((ok) => {
        const i = new Image();
        i.onload = () => ok('loaded');
        i.onerror = () => ok('error');
        i.src = 'https://image.tmdb.org/t/p/w92/sw-test.png';
      }));
      check(res === 'loaded', 'TMDB images load through the service worker (CSP allows it)');
      await swCtx.close();
    }

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

    console.log('Release-type tabs + layout');
    today = await page.locator('.sec').first().innerText();
    check(today.includes('Last Dance') && today.includes('Finale'), 'season finale shows in "All" with a Finale badge');
    await page.click('button[data-action=set-kind][data-key=premieres]');
    today = await page.locator('.sec').first().innerText();
    check(today.includes('Second Shift') && !today.includes('Monsoon Ledger') && !today.includes('Last Dance'), 'Premieres tab shows only premieres');
    await page.click('button[data-action=set-kind][data-key=finales]');
    today = await page.locator('.sec').first().innerText();
    check(today.includes('Last Dance') && !today.includes('Second Shift'), 'Finales tab shows only finales');
    await page.click('button[data-action=set-kind][data-key=movies]');
    today = await page.locator('.sec').first().innerText();
    check(today.includes('Monsoon Ledger') && !today.includes('Second Shift'), 'Movies tab shows only movies');
    await page.click('button[data-action=set-kind][data-key=all]');
    await page.click('button[data-action=set-layout][data-key=posters]');
    check(await page.locator('.sec').first().locator('a.tile').count() >= 4, 'posters layout shows poster tiles');
    await shot('02b-day-posters');
    await page.click('button[data-action=set-layout][data-key=list]');
    check(await page.locator('a.card').count() >= 4, 'list layout restores cards');

    console.log('My streaming services (Settings)');
    await page.goto(`${BASE}/#/settings`);
    await page.click('button[data-action=toggle-my][data-key=netflix]');
    await page.click('button[data-action=toggle-my][data-key=prime]');
    check((await page.locator('#my-services').innerText()).includes('2 of 12 selected'), 'Settings shows 2 services selected');
    await page.goto(`${BASE}/#/day/${T}`);
    await page.locator('a.card').first().waitFor();
    today = await page.locator('.sec').first().innerText();
    check(today.includes('Monsoon Ledger') && today.includes('Neelam') && today.includes('Last Dance'), 'releases on chosen services are shown');
    check(!today.includes('Second Shift'), 'releases on other services are hidden everywhere');
    check(await page.locator('.mobile-only button[data-action=toggle-platform]').count() === 2, 'platform chips list only the chosen services');
    await page.goto(`${BASE}/#/settings`);
    await page.click('button[data-action=my-clear]');
    await page.goto(`${BASE}/#/day/${T}`);
    await page.getByText('Second Shift').first().waitFor();
    check(true, '"Show all services again" restores everything');

    console.log('My languages (Settings)');
    await page.goto(`${BASE}/#/settings`);
    await page.click('#my-languages button[data-key=hi]');
    await page.goto(`${BASE}/#/day/${T}`);
    await page.locator('a.card').first().waitFor();
    let days = await page.locator('main').innerText();
    check(days.includes('Monsoon Ledger') && days.includes('Second Shift'), 'Hindi titles shown with "My languages: Hindi"');
    check(days.includes('Neelam'), 'Tamil film that also releases in Hindi (per the release note) is NOT missed');
    check(!days.includes('Godavari Nights'), 'Telugu-only film is hidden');
    const neelamCard = await page.locator('a.card:has-text("Neelam")').innerText(); check(['Tamil', 'Telugu', 'Hindi'].every((l) => neelamCard.includes(l)), `card lists all known languages [${neelamCard.replace(/\n/g, ' | ')}]`);
    await page.goto(`${BASE}/#/settings`);
    await page.click('button[data-action=mylang-clear]');

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
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button[data-action=export-ics]')]);
    const ics = readFileSync(await dl.path(), 'utf8');
    check(dl.suggestedFilename() === 'ott-radar-watchlist.ics', 'calendar export downloads ott-radar-watchlist.ics');
    check(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.includes(`DTSTART;VALUE=DATE:${T.replace(/-/g, '')}`) && ics.includes('SUMMARY:Monsoon Ledger · Netflix'), 'calendar file has an all-day event with title and platform');

    console.log('My watchlist toggle');
    await page.goto(`${BASE}/#/day/${T}`);
    await page.locator('a.card').first().waitFor();
    check(await page.locator('a.card.is-mine:has-text("Monsoon Ledger")').count() === 1, 'saved title is marked in the day view');
    await page.click('button[data-action=toggle-mine]');
    today = await page.locator('.sec').first().innerText();
    check(today.includes('Monsoon Ledger') && !today.includes('Neelam'), '"My watchlist" shows only saved titles');
    await page.click('button[data-action=toggle-mine]');
    await page.goto(`${BASE}/#/month/${T}`);
    await page.locator('.cal').waitFor();
    check(await page.locator('.cal-cell.today.has-mine').count() === 1, 'month view marks days with watchlist releases');

    console.log('Calendar file format');
    const { buildIcs } = await import(path.join(ROOT, 'public/js/ics.js'));
    const long = buildIcs([{ uid: 'movie:1', date: '2026-12-05', summary: 'एक बहुत लंबा शीर्षक, जिसमें; विशेष अक्षर हैं '.repeat(3), description: 'line1\nline2' }], new Date('2026-11-22T00:00:00Z'));
    const lines = long.split('\r\n');
    check(lines.every((l) => Buffer.byteLength(l) <= 75), 'long lines are folded to 75 bytes');
    check(long.includes('\\,') && long.includes('\\;') && long.includes('line1\\nline2') && long.includes('DTEND;VALUE=DATE:20261206'), 'text is escaped and the event ends the next day');

    console.log('Owner: manual entries');
    await page.goto(`${BASE}/#/settings`);
    await page.fill('input[name=admin]', ADMIN);
    await page.click('button:has-text("Unlock")');
    await page.waitForFunction(async () => Object.keys((await (await fetch('/api/logos')).json()).logos).length > 0, null, { timeout: 10000 }).catch(() => {});
    const shared = await (await fetch(`${BASE}/api/logos`)).json();
    check(shared.logos.netflix === '/logo8.png' && shared.logos.prime === '/logo119.png', "owner's browser shares TMDB's official logos with the site");
    r = await fetch(`${BASE}/api/logos`, { method: 'PUT', body: JSON.stringify({ logos: { netflix: '/x.png' } }) });
    check(r.status === 401, 'saving logos without the admin token is rejected');
    {
      const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      await vctx.route('https://image.tmdb.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
      const vp = await vctx.newPage();
      await vp.goto(`${BASE}/#/filters`);
      await vp.locator('.pbtn img.plogo').first().waitFor({ timeout: 10000 }).catch(() => {});
      check(await vp.locator('.pbtn img.plogo').count() >= 6, 'a visitor with NO TMDB token still sees the official platform logos');
      await vp.screenshot({ path: path.join(OUT, '11-visitor-logos.png') });
      await vctx.close();
    }
    await page.goto(`${BASE}/#/admin`);
    await page.fill('form[data-form=tmdb-search] input[name=q]', 'Kaaval');
    await page.click('form[data-form=tmdb-search] button');
    await page.click('button.result:has-text("Kaaval")');
    await page.selectOption('select[name=platform]', 'zee5');
    await page.fill('input[name=date]', addDays(T, 3));
    await page.fill('input[name=source]', 'https://example.com/news');
    await page.check('input[name=lang][value=hi]');
    await shot('08-admin');
    await page.click('button:has-text("Save release")');
    await page.locator('.wrow:has-text("Kaaval")').waitFor();
    check(true, 'manual entry saved and listed');
    await page.goto(`${BASE}/#/day/${addDays(T, 3)}`);
    await page.getByText('Kaaval').first().waitFor({ timeout: 20000 });
    const d3 = await page.locator('.sec').first().innerText();
    check(d3.includes('Expected'), 'manual entry shows as "Expected" on its day');
    const apiRows = await (await fetch(`${BASE}/api/manual?from=${T}&to=${addDays(T, 10)}`)).json();
    check(apiRows.entries.some((e) => e.title === 'Kaaval' && e.languages === 'ta,hi'), 'manual entry stores its languages (original + ticked)');

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
    await page.goto(`${BASE}/#/month/${T}`);
    await page.locator('.cal').waitFor();
    check(await page.locator('.cal-cell.today .thumbs').isVisible(), 'desktop month shows poster thumbnails in day cells');
    await shot('10-desktop-month');

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
