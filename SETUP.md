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
├── wrangler.toml              # Pages config (pages_build_output_dir = ".")
├── .dev.vars                  # local-only Fantrax cookie (gitignored)
└── SETUP.md
```

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

## Ranking model (v1)

- **Overall** — z-score sum across all 9 categories using every rostered player's
  per-game totals (counting cats summed, FG%/FT% averaged, TO inverted).
- **Contender** — same z-score, but only each team's **top 10 players** (by per-player
  z-value) — a win-now / starter-strength proxy.
- **Draft** — weighted sum of owned future picks (R1=30, R2=15, R3=8, R4=4).
- **Per-category** — straight rank of each team's category total.
- **Positional (G/F/C)** — z-score sum over each team's position-eligible players.

These are heuristics meant to be tuned later.
