# Holdat — Dynasty NBA viewer

A single static page + one Cloudflare Pages Function that reads a Fantrax dynasty
NBA league and renders every team as a card with **Overall / Contender / Draft**
ranks, a 9-category strip, and an expandable roster grouped by **G / G/F / F / F/C / C**.

Hosted at **holdat.ffhistorian.com** (Cloudflare Pages). No build step.

## Layout

```
holdat/
├── index.html                 # the whole page (HTML + CSS + JS, no framework)
├── functions/api/fantrax.js   # Pages Function — proxies Fantrax fxpa with stored cookie
├── functions/api/bbm.js       # Pages Function — scrapes Basketball Monster "BZ" (Bazemore) values
├── wrangler.toml              # Pages config (pages_build_output_dir = ".")
├── .dev.vars                  # local-only cookies, FANTRAX_COOKIE + BBM_COOKIE (gitignored)
└── SETUP.md
```

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

Methods used: `getFantasyTeams`, `getStandings`, `getTeamRosterInfo` (per team).

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

Configured in `index.html` (`LEAGUES` array):

| Season | League ID |
|--------|-----------|
| 26-27 (active) | `mkuoaxbhmqrct7rf` |
| 25-26 (history) | `zdmn1wu0md6fpz8d` |

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
