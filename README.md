# OTT Radar India

An installable web app that shows what's new on Indian streaming platforms (Netflix, Prime Video,
JioHotstar, ZEE5, SonyLIV, Aha, Sun NXT, Apple TV+, MX Player, Hoichoi, ManoramaMAX, ETV Win)
by **day, week and month**. It runs on Cloudflare Pages' free tier.

- **Bring your own TMDB token.** Each visitor pastes their own free TMDB token in Settings. It is
  stored only in their browser and sent only to `api.themoviedb.org`. The server never sees it.
- **Official platform logos** come from TMDB's watch-provider data at runtime (nothing is bundled).
- **Manual entries** (owner only): add an upcoming date you saw in the news, marked *Expected* or
  *Confirmed*. These are stored in Cloudflare D1 and override TMDB. If TMDB later disagrees, the
  title is flagged **Dates disagree**.
- **Watchlist + reminders** saved on the device. No accounts.
- **Works offline** for the data you've already loaded (6-hour device cache, service worker).

## How the data works

```
Browser + user's TMDB token ──► api.themoviedb.org   (discover by region IN, providers, dates)
Browser ──► /api/manual  (Cloudflare Pages Function) ──► D1  (owner's manual entries only)
```

For each month the app asks TMDB for:

1. **Movies** with an India *digital* release date (release type 4) in that month. A movie is kept
   if TMDB lists it on a tracked platform in India, or the release-date note names one.
2. **Series** on tracked platforms with an episode airing that month. These are grouped per show
   per day as *New series*, *Season N* premieres, or ordinary episodes. Ordinary episodes are hidden
   unless the **Every new episode** filter is on, because daily soaps would flood the list.

### Known limits (read these)

- TMDB often has **no India OTT date for upcoming or regional titles**. That is what manual entries
  are for.
- Visitors without a TMDB token see only manual entries. Signing up for TMDB is a real hurdle for
  non-technical people.
- A month's first load makes roughly 50–300 TMDB requests (one per title) and takes a few seconds.
  After that the month opens instantly from the device cache.
- Reminders fire **when the app is opened** on release day. True background push would need a
  push server and a scheduled Worker, which this version doesn't include. On iPhone,
  notifications only work after **Add to Home Screen**.
- Only languages are filtered by *original* language. TMDB has no reliable dub data.

## Deploy to Cloudflare

You need Node 18+ and a free Cloudflare account.

```bash
npm install
npx wrangler login

# 1. Database for manual entries
npx wrangler d1 create ott-radar-india        # copy the database_id into wrangler.toml
npm run db:remote                              # creates the table

# 2. Site
npx wrangler pages project create ott-radar-india --production-branch main
npm run deploy

# 3. Owner password for the "Add a release" screen (use a long random string)
npx wrangler pages secret put ADMIN_TOKEN --project-name ott-radar-india
npm run deploy                                 # redeploy so the secret is picked up
```

**Or use Git deploys:** push this folder to its own GitHub repo. In the Cloudflare dashboard, open
**Workers & Pages → Create → Pages → Connect to Git**. Leave the build command empty and set the
output directory to `public`. Then, in the project's **Settings**:

- under **Bindings**, add D1 database `DB` → `ott-radar-india`
- under **Variables and secrets**, add the secret `ADMIN_TOKEN`

### After deploying

1. Open the site → **Settings** → paste your TMDB **API Read Access Token**. Get it at
   themoviedb.org → Settings → API.
2. Owner only: in **Settings → Owner tools**, paste your `ADMIN_TOKEN` to unlock **Add a release**.

## Develop and test locally

```bash
npm run db:local      # create the local D1 table
npm run dev           # http://localhost:8788  (admin token: dev-admin-token)
npm i -D playwright && npx playwright install chromium
npm test              # end-to-end test against a mocked TMDB (no token needed)
```

`npm test` starts `wrangler pages dev` with a local D1 and replaces TMDB with a mock. It covers the
day, week and month views, filters, title detail, the watchlist, manual entries (add, override,
"Dates disagree", delete), the API's auth and validation, the CSP header, and the desktop layout.
Screenshots go to `test-output/`.

## Files

```
public/            static app (no build step)
  index.html, css/app.css, sw.js, manifest.webmanifest, _headers (CSP and security headers)
  js/app.js        router and all screens
  js/releases.js   TMDB month loading, manual merge, filters
  js/tmdb.js       TMDB client (Bearer token or v3 API key)
  js/platforms.js  tracked platforms, provider-name matching, logos
  js/store.js      localStorage: token, filters, watchlist, cache
functions/api/     Pages Functions: GET/POST /api/manual, DELETE /api/manual/:id
lib/manual.js      shared validation and auth for the functions
schema.sql         D1 table
tests/e2e.mjs      end-to-end test
```

This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability
data is provided by JustWatch through TMDB.
