// Cloudflare Pages Function — GET /api/admin/import-player-universe
//
// Fills `players` with the full current-season NBA player universe (not just
// players rostered on a holdat team), so free-agent search has somewhere to
// draw from. Source: stats.nba.com's commonallplayers endpoint -- free,
// unauthenticated (just needs browser-like headers or it 403s), no API key.
// balldontlie was considered and rejected (its free tier turned out to
// require billing details the user didn't want to hand over for this).
//
// Known gap: commonallplayers does NOT return position, so position
// eligibility for a player who's only a free agent (never on a holdat
// roster) stays blank until a later phase adds a source for it. Any player
// already known via the Fantrax importer keeps Fantrax's richer
// multi-position eligibility string untouched -- this sync only ever adds
// new free-agent rows or attaches an NBA person-id link, never overwrites
// position_eligibility.
//
// Two-way contract status also isn't in this response (see the Phase 1
// plan's open question 6) -- is_two_way stays NULL here, same as the
// Fantrax importer.
//
// ?token=<ADMIN_IMPORT_TOKEN>  required, same gate as /api/admin/import
// ?season=YYYY-YY              optional, defaults to the current NBA season

import { json, first, run } from '../../_lib/db.js';

const NBA_STATS_URL = 'https://stats.nba.com/stats/commonallplayers';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.nba.com/',
  Origin: 'https://www.nba.com',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
};

// NBA season labels span Oct-June (e.g. an Oct 2026 tipoff is "2026-27");
// treat September as the cutover month.
function currentNbaSeason(now = new Date()) {
  const y = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!env.ADMIN_IMPORT_TOKEN || token !== env.ADMIN_IMPORT_TOKEN) {
    return json({ error: 'Invalid or missing admin token.' }, 403);
  }
  if (!env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  const season = url.searchParams.get('season') || currentNbaSeason();
  const nbaUrl = `${NBA_STATS_URL}?LeagueID=00&Season=${encodeURIComponent(season)}&IsOnlyCurrentSeason=1`;

  let res;
  try {
    // stats.nba.com sometimes just doesn't respond (rather than erroring) to
    // requests it doesn't like -- an explicit timeout turns that into a clear
    // 502 instead of the request hanging indefinitely.
    res = await fetch(nbaUrl, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return json({ error: timedOut ? 'NBA.com did not respond within 15s (may be blocking this IP).' : `NBA.com fetch failed: ${(e && e.message) || e}` }, 502);
  }
  if (!res.ok) return json({ error: `NBA.com HTTP ${res.status}` }, 502);

  const data = await res.json();
  const rs = data.resultSets && data.resultSets[0];
  if (!rs || !Array.isArray(rs.rowSet)) return json({ error: 'Unexpected NBA.com response shape.' }, 502);

  const cols = rs.headers;
  const idx = (name) => cols.indexOf(name);
  const iId = idx('PERSON_ID'), iName = idx('DISPLAY_FIRST_LAST'),
    iTeamAbbr = idx('TEAM_ABBREVIATION'), iTeamCity = idx('TEAM_CITY'), iTeamName = idx('TEAM_NAME');
  if (iId < 0 || iName < 0) return json({ error: 'NBA.com response missing expected columns.' }, 502);

  const db = env.DB;
  const now = Date.now();
  let created = 0, linked = 0, skipped = 0;

  for (const row of rs.rowSet) {
    const personId = row[iId] != null ? String(row[iId]) : null;
    const name = row[iName];
    if (!personId || !name) { skipped++; continue; }

    const existingLink = await first(db, 'SELECT player_id FROM player_external_ids WHERE source = ? AND external_id = ?', 'nba', personId);
    let playerId = existingLink?.player_id ?? null;

    if (!playerId) {
      const existingByName = await first(db, 'SELECT id FROM players WHERE lower(full_name) = lower(?) LIMIT 1', name);
      if (existingByName) {
        playerId = existingByName.id;
      } else {
        const nbaTeam = row[iTeamAbbr] || null;
        const nbaTeamName = [row[iTeamCity], row[iTeamName]].filter(Boolean).join(' ') || null;
        const insertRes = await run(
          db,
          `INSERT INTO players (full_name, short_name, nba_team, nba_team_name, position_eligibility, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', ?, ?)`,
          name, name, nbaTeam, nbaTeamName, now, now
        );
        playerId = insertRes.meta.last_row_id;
        created++;
      }
      await run(
        db,
        `INSERT INTO player_external_ids (player_id, source, external_id) VALUES (?, 'nba', ?) ON CONFLICT DO NOTHING`,
        playerId, personId
      );
      linked++;
    }
  }

  return json({ ok: true, season, playersSeen: rs.rowSet.length, created, linked, skipped });
}
