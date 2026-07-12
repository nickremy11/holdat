// Cloudflare Pages Function — POST /api/admin/import
//
// One-time (occasionally re-run) importer: seeds the native D1 schema from a
// single Fantrax league/season, reusing functions/api/fantrax.js's existing
// fxReq/parseRoster/parseTrades/parsePickLabel rather than re-scraping.
// Fantrax stays scraped only as this importer's source -- the app owns
// rosters/lineups/trades/drafts going forward (see the Phase 1 plan).
//
// Every write is a natural-key upsert, so re-running this for any season is
// always safe and reconciles cross-season links (e.g. a pick traded before
// its season was imported) regardless of import order.
//
// Params:
//   ?token=<ADMIN_IMPORT_TOKEN>   required, same secret-gated pattern as
//                                 bbm.js's ?refresh= token
//   ?season=<fantraxLeagueId>    required
//   ?year=<YYYY>                 required unless season is a known key in
//                                 fantrax.js's YEAR_TO_LEAGUE
//   ?label=<text>&slug=<text>    required (e.g. "26-27 Dynasty", "league2627")
//   ?current=1                   marks this season status='active'
//   ?dryRun=1                    stop after franchise-mapping resolution and
//                                 return the proposed team->franchise mapping
//                                 for commissioner review -- no writes happen

import { json, first, all, run, upsert } from '../../_lib/db.js';
import { fxReq, parseRoster, parseTrades, CATS, LOWER_BETTER, YEAR_TO_LEAGUE } from '../fantrax.js';

const LEAGUE_TO_YEAR = Object.fromEntries(Object.entries(YEAR_TO_LEAGUE).map(([y, id]) => [id, parseInt(y, 10)]));
const RATE_CATS = new Set(['FG%', 'FT%']);

function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
}

// Fantrax's raw roster-slot statusId codes aren't confirmed anywhere in
// scraped data (Phase 1 plan, open question 2) -- default everyone 'active'
// and keep the raw code in roster_entries.fantrax_status_id so a commissioner
// can correct IR/reserve slots with a one-time UPDATE once confirmed against
// the live Fantrax UI.
function mapRosterStatus(_statusId) {
  return 'active';
}

// Franchise cross-season identity: exact name match first, then an
// unambiguous substring match (same heuristic resolveDraftedPicks() in
// fantrax.js already uses for teams that renamed between seasons).
async function resolveFranchise(db, teamName) {
  const key = teamName.trim().toLowerCase();
  const exact = await first(db, 'SELECT id, name FROM franchises WHERE lower(name) = ?', key);
  if (exact) return { franchiseId: exact.id, matchedName: exact.name, isNew: false };

  const candidates = await all(db, 'SELECT id, name FROM franchises');
  const hits = candidates.filter((f) => {
    const n = f.name.trim().toLowerCase();
    return n.includes(key) || key.includes(n);
  });
  if (hits.length === 1) return { franchiseId: hits[0].id, matchedName: hits[0].name, isNew: false };

  return { franchiseId: null, matchedName: null, isNew: true };
}

async function upsertPlayer(db, sc) {
  const now = Date.now();
  const playerId = await upsert(
    db, 'players', ['fantrax_scorer_id'],
    {
      fantrax_scorer_id: String(sc.scorerId),
      full_name: sc.name,
      short_name: sc.shortName || sc.name,
      nba_team: sc.nbaTeam || null,
      nba_team_name: sc.nbaTeamName || null,
      headshot_url: sc.headshot || null,
      position_eligibility: sc.pos || '',
      is_two_way: null,
      birth_date: null,
      created_at: now,
      updated_at: now,
    },
    ['created_at']
  );
  await upsert(db, 'player_external_ids', ['source', 'external_id'], {
    player_id: playerId, source: 'fantrax', external_id: String(sc.scorerId),
  });
  return playerId;
}

async function findPlayerByScorerId(db, scorerId) {
  if (!scorerId) return null;
  const row = await first(db, 'SELECT id FROM players WHERE fantrax_scorer_id = ?', String(scorerId));
  return row?.id ?? null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const fantraxLeagueId = url.searchParams.get('season');
  const isCurrent = url.searchParams.get('current') === '1';
  const dryRun = url.searchParams.get('dryRun') === '1';
  const year = parseInt(url.searchParams.get('year'), 10) || LEAGUE_TO_YEAR[fantraxLeagueId] || null;
  const label = url.searchParams.get('label');
  const slug = url.searchParams.get('slug');

  if (!env.ADMIN_IMPORT_TOKEN || token !== env.ADMIN_IMPORT_TOKEN) {
    return json({ error: 'Invalid or missing admin token.' }, 403);
  }
  if (!env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);
  if (!env.FANTRAX_COOKIE) return json({ error: 'FANTRAX_COOKIE secret is not set on this Pages project.' }, 500);
  if (!fantraxLeagueId) return json({ error: 'Missing ?season= (Fantrax league id).' }, 400);
  if (!year) return json({ error: 'Missing ?year= (could not be inferred from YEAR_TO_LEAGUE).' }, 400);
  if (!dryRun && (!label || !slug)) return json({ error: 'Missing ?label= and/or ?slug= for this season.' }, 400);

  const db = env.DB;
  const cookie = env.FANTRAX_COOKIE;
  const now = Date.now();
  const warnings = [];

  try {
    // --- Teams + franchise resolution (dry-run stops here) ---
    const teamsData = await fxReq('getFantasyTeams', { leagueId: fantraxLeagueId }, cookie);
    const fxTeams = teamsData.fantasyTeams || [];

    const franchiseReport = [];
    for (const t of fxTeams) {
      const resolved = await resolveFranchise(db, t.name);
      franchiseReport.push({ fantraxTeamId: t.id, teamName: t.name, ...resolved });
    }

    if (dryRun) {
      return json({ dryRun: true, season: fantraxLeagueId, year, teamCount: fxTeams.length, franchiseReport });
    }

    // --- leagues (singleton) + season + config ---
    let leagueRow = await first(db, 'SELECT id FROM leagues LIMIT 1');
    if (!leagueRow) {
      const res = await run(db, 'INSERT INTO leagues (name, created_at) VALUES (?, ?)', 'HOLDAT Dynasty', now);
      leagueRow = { id: res.meta.last_row_id };
    }
    const leagueId = leagueRow.id;

    const seasonId = await upsert(
      db, 'seasons', ['fantrax_league_id'],
      {
        league_id: leagueId, year, label, slug,
        fantrax_league_id: fantraxLeagueId,
        status: isCurrent ? 'active' : 'complete',
        start_date: null, end_date: null, created_at: now,
      },
      ['created_at']
    );

    await upsert(db, 'season_settings', ['season_id'], {
      season_id: seasonId, roster_size: null, bench_slots: null, ir_slots: null,
      keeper_rules: null, playoff_format: null, notes: null,
    }, [], 'season_id');

    for (let i = 0; i < CATS.length; i++) {
      const code = CATS[i];
      await upsert(db, 'scoring_categories', ['season_id', 'code'], {
        season_id: seasonId, code, display_order: i,
        category_type: RATE_CATS.has(code) ? 'rate' : 'counting',
        lower_is_better: LOWER_BETTER.has(code) ? 1 : 0,
      });
    }

    // --- Franchises + teams ---
    const teamIdByFantraxId = {};
    const franchiseIdByFantraxTeamId = {};
    for (const t of fxTeams) {
      const rep = franchiseReport.find((r) => r.fantraxTeamId === t.id);
      let franchiseId = rep.franchiseId;
      if (!franchiseId) {
        const res = await run(
          db, 'INSERT INTO franchises (name, short_name, logo_url, created_at) VALUES (?, ?, ?, ?)',
          t.name, t.shortName || null, t.logoUrl128 || t.logoUrl256 || null, now
        );
        franchiseId = res.meta.last_row_id;
      }
      franchiseIdByFantraxTeamId[t.id] = franchiseId;

      const teamId = await upsert(db, 'teams', ['season_id', 'fantrax_team_id'], {
        season_id: seasonId,
        franchise_id: franchiseId,
        name: t.name,
        short_name: t.shortName || null,
        slug: slugify(t.name),
        logo_url: t.logoUrl128 || t.logoUrl256 || null,
        fantrax_team_id: String(t.id),
        draft_slot: null,
      });
      teamIdByFantraxId[t.id] = teamId;
    }

    // --- Standings snapshot ---
    const standingsData = await fxReq('getStandings', { leagueId: fantraxLeagueId }, cookie);
    const tl = standingsData.tableList && standingsData.tableList[0];
    if (tl && tl.rows) {
      const hdr = (tl.header.cells || []).map((c) => c.shortName || c.name);
      for (const row of tl.rows) {
        const fixed = row.fixedCells || [];
        const fantraxTeamId = fixed[1] && fixed[1].teamId;
        if (!fantraxTeamId || !teamIdByFantraxId[fantraxTeamId]) continue;
        const cells = row.cells || [];
        const rec = {};
        hdr.forEach((h, i) => { rec[h] = cells[i] && cells[i].content; });
        await upsert(db, 'season_standings', ['team_id'], {
          team_id: teamIdByFantraxId[fantraxTeamId],
          rank: fixed[0]?.content != null ? parseInt(fixed[0].content, 10) : null,
          wins: rec['W'] != null ? parseInt(rec['W'], 10) : null,
          losses: rec['L'] != null ? parseInt(rec['L'], 10) : null,
          ties: rec['T'] != null ? parseInt(rec['T'], 10) : null,
          win_pct: rec['Win%'] || null,
          pts_for: rec['PtsF'] != null ? parseFloat(rec['PtsF']) : null,
          pts_against: rec['PtsA'] != null ? parseFloat(rec['PtsA']) : null,
        });
      }
    }

    // --- Rosters (players + roster_entries + future draft-pick ownership) ---
    const rosterPicksByFantraxTeam = {};
    for (const t of fxTeams) {
      const rosterData = await fxReq('getTeamRosterInfo', { leagueId: fantraxLeagueId, teamId: t.id }, cookie);
      const parsed = parseRoster(rosterData);
      rosterPicksByFantraxTeam[t.id] = parsed.picks;
      const teamId = teamIdByFantraxId[t.id];

      for (const p of parsed.players) {
        if (!p.scorerId) continue;
        const playerId = await upsertPlayer(db, p);
        await upsert(
          db, 'roster_entries', ['team_id', 'player_id'],
          {
            team_id: teamId, player_id: playerId, slot_id: null,
            status: mapRosterStatus(p.statusId),
            fantrax_status_id: p.statusId != null ? String(p.statusId) : null,
            is_rookie_season: p.rookie ? 1 : 0,
            acquired_at: now, acquired_via: 'import',
            created_at: now, updated_at: now,
          },
          ['created_at', 'acquired_at', 'acquired_via']
        );
      }
    }

    for (const t of fxTeams) {
      const picks = rosterPicksByFantraxTeam[t.id] || [];
      const currentFranchiseId = franchiseIdByFantraxTeamId[t.id];
      for (const yearEntry of picks) {
        for (const d of yearEntry.detail || []) {
          const originalFranchiseId = franchiseIdByFantraxTeamId[d.from] || currentFranchiseId;
          await upsert(
            db, 'draft_pick_assets', ['draft_year', 'round', 'original_franchise_id'],
            {
              draft_year: yearEntry.year, round: d.round,
              original_franchise_id: originalFranchiseId,
              current_franchise_id: currentFranchiseId,
              draft_pick_id: null, created_at: now,
            },
            ['created_at', 'draft_pick_id']
          );
        }
      }
    }

    // --- Draft results ---
    const draftData = await fxReq('getDraftResults', { leagueId: fantraxLeagueId }, cookie).catch(() => null);
    if (draftData) {
      for (const s of draftData.scorers || []) {
        if (!s.scorerId) continue;
        await upsertPlayer(db, {
          scorerId: s.scorerId, name: s.name, shortName: s.name,
          nbaTeam: s.teamShortName || null, nbaTeamName: null,
          pos: s.posShortNames || '', headshot: s.headshotUrl || null,
        });
      }

      const order = draftData.fantasyTeamsOrdered || [];
      const slotsPerRound = order.length || fxTeams.length;
      const picksOrdered = draftData.draftPicksOrdered || [];
      const rounds = picksOrdered.reduce((max, p) => Math.max(max, p.round), 0);
      const allDrafted = picksOrdered.length > 0 && picksOrdered.every((p) => p.scorerId);
      const anyDrafted = picksOrdered.some((p) => p.scorerId);

      const draftClassId = await upsert(db, 'draft_classes', ['season_id'], {
        season_id: seasonId, draft_type: 'rookie', rounds, slots_per_round: slotsPerRound,
        status: allDrafted ? 'complete' : anyDrafted ? 'in_progress' : 'scheduled',
        completed_at: null,
      });

      const franchiseIdBySlot = {};
      for (let i = 0; i < order.length; i++) {
        const slot = i + 1;
        const teamId = teamIdByFantraxId[order[i].id];
        if (!teamId) continue;
        await upsert(db, 'draft_order', ['draft_class_id', 'slot'], {
          draft_class_id: draftClassId, slot, team_id: teamId,
        });
        franchiseIdBySlot[slot] = franchiseIdByFantraxTeamId[order[i].id];
      }

      for (const p of picksOrdered) {
        const teamId = teamIdByFantraxId[p.teamId];
        if (!teamId) { warnings.push(`draft pick R${p.round} slot ${p.pickNumber}: unknown team ${p.teamId}`); continue; }
        const playerId = await findPlayerByScorerId(db, p.scorerId);
        const overallPick = slotsPerRound ? (p.round - 1) * slotsPerRound + p.pickNumber : p.pickNumber;

        const draftPickId = await upsert(db, 'draft_picks', ['draft_class_id', 'round', 'slot'], {
          draft_class_id: draftClassId, round: p.round, slot: p.pickNumber,
          overall_pick: overallPick, team_id: teamId, player_id: playerId, drafted_at: null,
        });

        const originalFranchiseId = franchiseIdBySlot[p.pickNumber];
        if (originalFranchiseId) {
          await upsert(
            db, 'draft_pick_assets', ['draft_year', 'round', 'original_franchise_id'],
            {
              draft_year: year, round: p.round, original_franchise_id: originalFranchiseId,
              current_franchise_id: franchiseIdByFantraxTeamId[p.teamId] || originalFranchiseId,
              draft_pick_id: draftPickId, created_at: now,
            },
            ['created_at']
          );
        }
      }
    }

    // --- Trade history ---
    const tradeRows = [];
    let page = 1, totalPages = 1;
    do {
      const out = await fxReq('getTransactionDetailsHistory', {
        leagueId: fantraxLeagueId, view: 'TRADE', pageNumber: page, maxResultsPerPage: 100,
      }, cookie);
      const tbl = out && out.table;
      tradeRows.push(...((tbl && tbl.rows) || []));
      totalPages = (out && out.paginatedResultSet && out.paginatedResultSet.totalNumPages) || 1;
      page += 1;
    } while (page <= totalPages && page <= 10);

    const trades = parseTrades(tradeRows);
    for (const trade of trades) {
      const tradedAtMs = trade.date ? Date.parse(trade.date) : NaN;
      const tradeId = await upsert(
        db, 'trades', ['fantrax_tx_set_id'],
        {
          season_id: seasonId, fantrax_tx_set_id: String(trade.id),
          traded_at: Number.isFinite(tradedAtMs) ? tradedAtMs : now,
          week: trade.week != null ? parseInt(trade.week, 10) : null,
          notes: null, created_at: now,
        },
        ['created_at']
      );

      // Legs have no independent natural identity beyond "this trade's set of
      // moves" -- replace wholesale rather than upsert leg-by-leg.
      await run(db, 'DELETE FROM trade_legs WHERE trade_id = ?', tradeId);

      for (const leg of trade.legs) {
        const fromTeamId = teamIdByFantraxId[leg.fromId];
        const toTeamId = teamIdByFantraxId[leg.toId];
        if (!fromTeamId || !toTeamId) { warnings.push(`trade ${trade.id}: unresolved team on a leg`); continue; }
        const asset = leg.asset;

        if (asset.kind === 'player') {
          let playerId = await findPlayerByScorerId(db, asset.scorerId);
          if (!playerId) {
            const row = await first(
              db, 'SELECT id FROM players WHERE full_name = ? AND (nba_team = ? OR ? IS NULL) LIMIT 1',
              asset.name, asset.nbaTeam, asset.nbaTeam
            );
            playerId = row?.id ?? null;
          }
          if (!playerId) { warnings.push(`trade ${trade.id}: could not resolve player "${asset.name}"`); continue; }
          await run(
            db,
            `INSERT INTO trade_legs (trade_id, from_team_id, to_team_id, asset_type, player_id, draft_pick_asset_id)
             VALUES (?, ?, ?, 'player', ?, NULL) ON CONFLICT DO NOTHING`,
            tradeId, fromTeamId, toTeamId, playerId
          );
        } else if (asset.kind === 'pick' && asset.round != null && asset.year != null) {
          let originalFranchiseId = null;
          if (asset.pick != null) {
            const row = await first(
              db,
              `SELECT f.id FROM draft_order do
               JOIN draft_classes dc ON dc.id = do.draft_class_id
               JOIN seasons s ON s.id = dc.season_id
               JOIN teams t ON t.id = do.team_id
               JOIN franchises f ON f.id = t.franchise_id
               WHERE s.year = ? AND do.slot = ?`,
              asset.year, asset.pick
            );
            originalFranchiseId = row?.id ?? null;
          } else if (asset.origTeamName) {
            originalFranchiseId = (await resolveFranchise(db, asset.origTeamName)).franchiseId;
          }
          if (!originalFranchiseId) {
            warnings.push(`trade ${trade.id}: could not place pick (year ${asset.year}, round ${asset.round}) -- reconcile on a later re-import`);
            continue;
          }

          const toTeamRow = await first(db, 'SELECT franchise_id FROM teams WHERE id = ?', toTeamId);
          const pickAssetId = await upsert(
            db, 'draft_pick_assets', ['draft_year', 'round', 'original_franchise_id'],
            {
              draft_year: asset.year, round: asset.round, original_franchise_id: originalFranchiseId,
              current_franchise_id: toTeamRow?.franchise_id ?? originalFranchiseId,
              draft_pick_id: null, created_at: now,
            },
            ['created_at', 'draft_pick_id']
          );

          await run(
            db,
            `INSERT INTO trade_legs (trade_id, from_team_id, to_team_id, asset_type, player_id, draft_pick_asset_id)
             VALUES (?, ?, ?, 'pick', NULL, ?) ON CONFLICT DO NOTHING`,
            tradeId, fromTeamId, toTeamId, pickAssetId
          );
        }
      }
    }

    return json({
      ok: true, season: fantraxLeagueId, seasonId, year,
      teams: fxTeams.length, trades: trades.length, warnings,
    });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (msg === 'FANTRAX_NOT_LOGGED_IN') {
      return json({ error: 'Fantrax session expired. Refresh the FANTRAX_COOKIE secret.', code: 'NOT_LOGGED_IN' }, 401);
    }
    return json({ error: msg }, 502);
  }
}

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
