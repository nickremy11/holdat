# Holdat — Dynasty NBA viewer

A multi-page static site + Cloudflare Pages Functions that read a Fantrax dynasty
NBA league. Two pages, linked via the top nav: **`/`** (per-season team cards with
Overall / Contender / Draft ranks, a 9-category strip, and an expandable roster
grouped by G / G/F / F / F/C / C — one season at a time, picked via the league
dropdown) and **`/trades`** (every executed trade **across all seasons**, merged
into one timeline with a year divider whenever the year changes, plus a team
filter — `/trades?team=Name` deep-links to a specific team's trades). A
**`/history`** page (league history — champions, standings-by-season, etc.) is
planned next.

Hosted at **holdat.ffhistorian.com** (Cloudflare Pages). No build step — Cloudflare
Pages serves `foo.html` for a request to `/foo` automatically (same "clean URL"
behavior used by the sibling `sleeper-helper` project's `/analyzer`).

## Layout

```
holdat/
├── index.html                 # Rosters page ("/") — HTML + CSS + JS, no framework
├── trades.html                # Trade History page ("/trades") — same style, self-contained
├── shared.js                  # LEAGUES list, esc/displayPos/curLeague, league-switcher — used by both pages
├── functions/api/fantrax.js   # Pages Function — proxies Fantrax fxpa with stored cookie
├── functions/api/bbm.js       # Pages Function — scrapes Basketball Monster "BZ" (Bazemore) values
├── wrangler.toml              # Pages config (pages_build_output_dir = ".")
├── .dev.vars                  # local-only cookies, FANTRAX_COOKIE + BBM_COOKIE (gitignored)
├── functions/_lib/            # db.js (D1 helpers), auth.js (sessions), email.js (magic-link sender)
├── functions/api/auth/        # request-link, verify, logout, me — magic-link login
├── functions/api/admin/       # import.js (Fantrax -> D1), import-player-universe.js (NBA.com -> D1)
├── migrations/                # D1 schema, applied via `wrangler d1 migrations apply`
├── _redirects                 # currently a no-op — see "Current status" below
└── SETUP.md
```

## Current status (post-Phase-1)

Phase 1 (auth, native D1 data model, Fantrax importer) is built and deployed.
It is **infrastructure with nothing user-facing on top of it yet** — read this
section before assuming any of it is usable end-to-end.

**Live and unchanged**: `index.html` (`/`) and `trades.html` (`/trades`) still
read live from Fantrax on every page load, exactly as before Phase 1. No D1
involved in what a visitor actually sees today.

**Built and deployed, but dormant**:
- **D1 schema** — full schema (leagues, seasons, franchises, teams, players,
  rosters, draft, trades, matchups/stats tables — see `migrations/`).
  Populated with real data for seasons **23-24, 24-25, 25-26**. **26-27 is
  intentionally not yet imported** — pending the live 26-27 draft finishing;
  run it after with (season/year/label/slug per the Leagues table below):
  ```bash
  curl -X POST ".../api/admin/import?season=mkuoaxbhmqrct7rf&year=2026&label=26-27&slug=league2627&current=1&token=$ADMIN_IMPORT_TOKEN"
  ```
- **Magic-link auth** (`/api/auth/request-link`, `verify`, `logout`, `me`) —
  functional, but **zero owner accounts exist in production** (no `users`
  rows, no `franchises.owner_user_id` linked), and there's **no `/login`
  page** yet. Nothing user-facing uses this today.
- **Admin import tools** (`functions/api/admin/import.js`,
  `import-player-universe.js`) — one-time/occasional commissioner tools
  gated by `ADMIN_IMPORT_TOKEN`, not end-user-facing.
  **Lesson learned the hard way**: write every row through
  `functions/_lib/db.js`'s `batchUpsert`/`batchInsert`/`batchRun` (D1's
  `batch()` API), never one `await`-per-row `INSERT`/`UPDATE` — a season
  import does hundreds of rows, and Cloudflare caps subrequests per Worker
  invocation (50 on the free plan). The original per-row version worked fine
  under local `wrangler dev` (which doesn't enforce the limit) and then
  failed in production.

**Not built at all**: no `/login` page, no commissioner tool to seed owner
accounts or link them to franchises, no lineup/roster editing
(`roster_entries.slot_id` is `NULL` for every player, `lineup_slots` has zero
configured rows for any season, no write endpoint exists for it), no
commissioner UI for roster rules (`season_settings` rows exist but every
field is `NULL`).

**Next up**: `/login` page, a commissioner tool to seed the 14 owners and
link each to their franchise, `lineup_slots`/`season_settings` configuration,
and the actual lineup-editing UI/endpoint. `index.html` should keep reading
live from Fantrax until lineup editing ships and makes D1 authoritative for
roster state — switching sooner risks a Fantrax-side move silently going
stale.

**`_redirects` note**: path-based season/team routing (`/league2627/[team]`)
was tried and reverted — Cloudflare's redirect placeholders match *any*
single path segment, so `/:season` and `/:season/:team` silently served
`/shared.js`, `/trades`, and `/assets/hype.png` as the homepage HTML instead
of their real content (wrong MIME type, broke the page). Full explanation is
in the comments inside `_redirects` itself. Any future attempt needs a
scheme that can't collide with real filenames (e.g. a `/s/:season` prefix).

### One-time setup (D1 + email, already done in production)

```bash
# 1. Create the D1 database and wire the binding into wrangler.toml
npx wrangler d1 create holdat

# 2. Apply the schema
npx wrangler d1 migrations apply holdat --local     # for `wrangler pages dev`
npx wrangler d1 migrations apply holdat --remote    # for production

# 3. Secrets (already set in production; values live in a password manager,
#    not here — this file is committed to git)
npx wrangler pages secret put ADMIN_IMPORT_TOKEN     # gates /api/admin/*
npx wrangler pages secret put RESEND_API_KEY         # from resend.com/api-keys
npx wrangler pages secret put EMAIL_FROM             # e.g. accounts@ffhistorian.com
```

Email sends via [Resend](https://resend.com), not Cloudflare's own Email
Sending API — that needs a Workers Paid plan to send to arbitrary recipients,
which this project doesn't have. Resend's free tier (3,000 emails/mo) has no
such dependency. One-time setup at resend.com: create a free account, add +
DNS-verify the sending domain (SPF/DKIM records at your DNS host), create an
API key. If this needs to change providers again, `functions/_lib/email.js`
is the only file that talks to the provider.

Locally, `ADMIN_IMPORT_TOKEN` / `RESEND_API_KEY` / `EMAIL_FROM` have
placeholder entries in `.dev.vars` (gitignored) — fill in a real
`RESEND_API_KEY` there to test the login-link email locally.

### Running the importer

Oldest season first, so each season's draft order exists before later trades
reference its picks (safe to re-run all of them afterward in any order — every
write is a natural-key upsert):

```bash
# Dry run first — review the proposed team -> franchise mapping before writing anything
curl -X POST ".../api/admin/import?season=qybhh93dlge64jyi&year=2023&label=23-24&slug=league2324&dryRun=1&token=$ADMIN_IMPORT_TOKEN"

# Then for real, oldest -> newest, marking only the active season current=1
curl -X POST ".../api/admin/import?season=qybhh93dlge64jyi&year=2023&label=23-24&slug=league2324&token=$ADMIN_IMPORT_TOKEN"
curl -X POST ".../api/admin/import?season=uxe3kqislwu07xfm&year=2024&label=24-25&slug=league2425&token=$ADMIN_IMPORT_TOKEN"
curl -X POST ".../api/admin/import?season=zdmn1wu0md6fpz8d&year=2025&label=25-26&slug=league2526&token=$ADMIN_IMPORT_TOKEN"
curl -X POST ".../api/admin/import?season=mkuoaxbhmqrct7rf&year=2026&label=26-27&slug=league2627&current=1&token=$ADMIN_IMPORT_TOKEN"

# Once: full NBA + two-way player universe for free-agent search (source: NBA.com, free)
curl ".../api/admin/import-player-universe?token=$ADMIN_IMPORT_TOKEN"
```

Each page is self-contained (own `<style>` block, own load()) but shares `shared.js`
for the league list and small helpers, so adding a season only means editing one
`LEAGUES` array. When adding a new page (e.g. future `/history`), follow the same
pattern: copy the shared shell (blacktop background, header, pagebar CSS) from
`trades.html`, include `shared.js`, and add a nav link + `active` page-tab.

## Secrets

Two cookies, both stored as Pages secrets (server-side only, never sent to the browser):

| Secret | What | Refresh when |
|--------|------|--------------|
| `FANTRAX_COOKIE` | Fantrax session (`JSESSIONID` + friends) | page shows "Fantrax session expired" |
| `BBM_COOKIE` | Basketball Monster session (`ASP.NET_SessionId` + `RotoMonsterUserId`) | Overall note shows "Basketball Monster unavailable" |

```bash
npx wrangler pages secret put FANTRAX_COOKIE
npx wrangler pages secret put BBM_COOKIE
```

Locally, both live in `.dev.vars` (gitignored) as `NAME="value"` lines.

## Basketball Monster (BZ / Bazemore dynasty value)

`/api/bbm` GETs basketballmonster.com/playerrankings.aspx with `BBM_COOKIE`, then
re-posts the form flipping the player filter to **All Players** (~582 vs ~370),
inheriting the account's saved **HOLDAT league + BZ (Bazemore) column** config. It
parses `{ normalizedName: bzValue }` and caches ~6h. The client matches by
normalized name (~97% of rostered players) and uses the **sum of BZ** for the
**Overall** rank (falls back to the 9-cat z-score if BBM is unavailable).

Requirements on the BBM account: the **BZ column must stay in the saved display
config**, and the league dropdown should be the HOLDAT league. ~11 players miss on
name-format (Alexandre vs Alex Sarr, Herb vs Herbert Jones, Bub vs Carlton
Carrington…) or season-ending injuries — candidates for a future alias map.

## How Fantrax access works

Fantrax has **no public API**. The page uses Fantrax's internal `POST /fxpa/req`
endpoint, which requires a **logged-in session cookie**. The cookie is stored as a
Pages secret (`FANTRAX_COOKIE`) and only ever lives server-side in the Function —
it is never sent to the browser.

Methods used: `getFantasyTeams`, `getStandings`, `getTeamRosterInfo` (per team),
`getDraftResults` (draft slots), `getTransactionDetailsHistory` (trade history —
`?type=trades`, fetched only by `/trades`, not by the Rosters page). `/trades`
calls `?type=trades` (and `?type=teams`, for logos) **once per league in
`LEAGUES`**, in parallel, then merges + sorts the results client-side — so it
always shows the full multi-season history regardless of which single league the
Rosters page has selected.

### Trade History resolves "who was drafted" for traded picks

Each dynasty season is its **own Fantrax league ID** (see Leagues below), and a
traded pick's year identifies which league ran that draft — `YEAR_TO_LEAGUE` in
`functions/api/fantrax.js` maps them (extend this when a new season's league is
added). `resolveDraftedPicks()` fetches that league's `getDraftResults` and looks
up the pick two ways:
- **Slot already known at trade time** ("Pick 5") — matched directly against that
  draft's `draftPicksOrdered`.
- **Slot not yet known** — Fantrax instead shows the *original owner's team name*
  in parens (e.g. `"Round 2 (KC Voyagers)"`); that team's slot is found via the
  target draft's `fantasyTeamsOrdered`, with a substring fallback for teams that
  renamed between seasons.

Only resolves once the draft has actually happened (a `scorerId` exists on that
slot) — future picks correctly show no drafted player yet.

### The cookie expires

Fantrax sessions expire every few weeks. When the page shows
*"Fantrax session expired"*, refresh the cookie (see below). Later we can move the
cookie into a small settings UI so it doesn't need a redeploy.

## Getting the cookie

1. Log into fantrax.com in Chrome, open the league.
2. DevTools → Network → click anything so a `fxpa/req` request appears.
3. Click it → Headers → Request Headers → copy the full `Cookie:` value.
   (Only `JSESSIONID`, `uig`, `ui`, `cf_clearance`, `fsuid`, `FX_RM` are really needed.)

## Local dev

```bash
cd holdat
# .dev.vars already holds FANTRAX_COOKIE=... for local runs
npx wrangler pages dev .
# open the printed localhost URL
```

## Deploy

```bash
cd holdat
# one-time: store the cookie as a production secret
npx wrangler pages secret put FANTRAX_COOKIE
# deploy
npx wrangler pages deploy .
```

Then bind the custom domain **holdat.ffhistorian.com** to the Pages project in the
Cloudflare dashboard (Pages → holdat → Custom domains).

## Leagues

Configured in `shared.js` (`LEAGUES` array — shared by both pages):

| Season | League ID |
|--------|-----------|
| 26-27 (active) | `mkuoaxbhmqrct7rf` |
| 25-26 (history) | `zdmn1wu0md6fpz8d` |
| 24-25 (history) | `uxe3kqislwu07xfm` |
| 23-24 (history) | `qybhh93dlge64jyi` |

## Ranking model

- **Overall** — rank of each team's **dynasty-value total** (sum of BZ). Negative
  handling: matched players sorted by value desc; the top 12 count as-is, the 13th+
  only count if positive (negatives → 0). The total is shown on the card as "Value".
  Falls back to a 9-cat z-score if BZ values are unavailable.
- **Contender** — 9-cat z-score over each team's **top 10 players** (win-now proxy).
- **Draft** — sum of pick values. For the upcoming draft (real slots), linear within
  each round: **R1 150→60, R2 55→40, R3 30→0** across slots 1–14. Future-year picks
  (no slot yet) are valued at the mid-slot with a 0.9^(years-out) discount.
- **Per-category** — straight rank of each team's category total.
- **Positional (G/F/C)** — rank of summed positive BZ over **all position-eligible**
  players (a multi-eligible player counts in each group; intentional double count).
  Falls back to a 9-cat z-score if BZ is unavailable.

BZ (Bazemore dynasty value) is never displayed per-player; only team **totals** and
**ranks** are shown.
