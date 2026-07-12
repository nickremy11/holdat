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
// IMPORTANT: writes are batched (see functions/_lib/db.js's batchUpsert/
// batchInsert/batchRun). Cloudflare caps the number of subrequests (fetches +
// D1 calls) a single Worker invocation may make -- an earlier version of this
// file did one `await` per player/pick/trade-leg and blew through that limit
// on a real season (hundreds of rows). Everything below collects rows into
// arrays first and writes each table in one (or a handful of chunked) D1
// batch call(s) instead.
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

import { json, first, all, run, batchUpsert, batchInsert, batchRun } from '../../_lib/db.js';
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
// fantrax.js already uses for teams that renamed between seasons). Operates
// on an in-memory candidate list (loaded once per request) rather than a
// per-team SELECT, which is what let this blow the subrequest budget before.
function matchFranchise(candidates, teamName) {
  const key = teamName.trim().toLowerCase();
  const exact = candidates.find((f) => f.name.trim().toLowerCase() === key);
  if (exact) return exact.id;
  const hits = candidates.filter((f) => {
    const n = f.name.trim().toLowerCase();
    return n.includes(key) || key.includes(n);
  });
  return hits.length === 1 ? hits[0].id : null;
}

function playerRow(sc, now) {
  return {
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
  };
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
    // ================= Fetch everything from Fantrax first ==================
    const teamsData = await fxReq('getFantasyTeams', { leagueId: fantraxLeagueId }, cookie);
    const fxTeams = teamsData.fantasyTeams || [];

    const franchiseCandidates = await all(db, 'SELECT id, name FROM franchises');

    const franchiseReport = fxTeams.map((t) => {
      const id = matchFranchise(franchiseCandidates, t.name);
      const matched = id ? franchiseCandidates.find((f) => f.id === id) : null;
      return { fantraxTeamId: t.id, teamName: t.name, franchiseId: id, matchedName: matched?.name ?? null, isNew: !id };
    });

    if (dryRun) {
      return json({ dryRun: true, season: fantraxLeagueId, year, teamCount: fxTeams.length, franchiseReport });
    }

    const standingsData = await fxReq('getStandings', { leagueId: fantraxLeagueId }, cookie);

    const rosterDataByFantraxTeam = {};
    for (const t of fxTeams) {
      rosterDataByFantraxTeam[t.id] = parseRoster(
        await fxReq('getTeamRosterInfo', { leagueId: fantraxLeagueId, teamId: t.id }, cookie)
      );
    }

    const draftData = await fxReq('getDraftResults', { leagueId: fantraxLeagueId }, cookie).catch(() => null);

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

    // ============================ leagues/season =============================
    let leagueRow = await first(db, 'SELECT id FROM leagues LIMIT 1');
    if (!leagueRow) {
      const res = await run(db, 'INSERT INTO leagues (name, created_at) VALUES (?, ?)', 'HOLDAT Dynasty', now);
      leagueRow = { id: res.meta.last_row_id };
    }
    const leagueId = leagueRow.id;

    const [seasonId] = await batchUpsert(
      db, 'seasons', ['fantrax_league_id'],
      [{
        league_id: leagueId, year, label, slug,
        fantrax_league_id: fantraxLeagueId,
        status: isCurrent ? 'active' : 'complete',
        start_date: null, end_date: null, created_at: now,
      }],
      ['created_at']
    );

    await batchUpsert(db, 'season_settings', ['season_id'], [{
      season_id: seasonId, roster_size: null, bench_slots: null, ir_slots: null,
      keeper_rules: null, playoff_format: null, notes: null,
    }], [], 'season_id');

    await batchUpsert(
      db, 'scoring_categories', ['season_id', 'code'],
      CATS.map((code, i) => ({
        season_id: seasonId, code, display_order: i,
        category_type: RATE_CATS.has(code) ? 'rate' : 'counting',
        lower_is_better: LOWER_BETTER.has(code) ? 1 : 0,
      }))
    );

    // ========================= franchises + teams =============================
    const newFranchiseTeams = fxTeams.filter((t) => !franchiseReport.find((r) => r.fantraxTeamId === t.id).franchiseId);
    const newFranchiseIds = await batchInsert(
      db, 'franchises',
      newFranchiseTeams.map((t) => ({
        name: t.name, short_name: t.shortName || null, logo_url: t.logoUrl128 || t.logoUrl256 || null, created_at: now,
      }))
    );
    const franchiseIdByFantraxTeamId = {};
    newFranchiseTeams.forEach((t, i) => { franchiseIdByFantraxTeamId[t.id] = newFranchiseIds[i]; });
    for (const rep of franchiseReport) {
      if (rep.franchiseId) franchiseIdByFantraxTeamId[rep.fantraxTeamId] = rep.franchiseId;
    }

    const teamIds = await batchUpsert(
      db, 'teams', ['season_id', 'fantrax_team_id'],
      fxTeams.map((t) => ({
        season_id: seasonId,
        franchise_id: franchiseIdByFantraxTeamId[t.id],
        name: t.name,
        short_name: t.shortName || null,
        slug: slugify(t.name),
        logo_url: t.logoUrl128 || t.logoUrl256 || null,
        fantrax_team_id: String(t.id),
        draft_slot: null,
      }))
    );
    const teamIdByFantraxId = {};
    fxTeams.forEach((t, i) => { teamIdByFantraxId[t.id] = teamIds[i]; });
    const franchiseIdByTeamId = {};
    fxTeams.forEach((t) => { franchiseIdByTeamId[teamIdByFantraxId[t.id]] = franchiseIdByFantraxTeamId[t.id]; });

    // ============================ standings snapshot ===========================
    const standingsRows = [];
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
        standingsRows.push({
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
    await batchUpsert(db, 'season_standings', ['team_id'], standingsRows);

    // ===== players (rosters + draft scorers, deduped) + roster_entries =========
    const playerSourceByScorerId = new Map();
    for (const t of fxTeams) {
      for (const p of rosterDataByFantraxTeam[t.id].players) {
        if (p.scorerId) playerSourceByScorerId.set(String(p.scorerId), p);
      }
    }
    for (const s of (draftData && draftData.scorers) || []) {
      if (!s.scorerId) continue;
      if (!playerSourceByScorerId.has(String(s.scorerId))) {
        playerSourceByScorerId.set(String(s.scorerId), {
          scorerId: s.scorerId, name: s.name, shortName: s.name,
          nbaTeam: s.teamShortName || null, nbaTeamName: null,
          pos: s.posShortNames || '', headshot: s.headshotUrl || null,
        });
      }
    }

    const scorerIds = [...playerSourceByScorerId.keys()];
    const playerIds = await batchUpsert(
      db, 'players', ['fantrax_scorer_id'],
      scorerIds.map((id) => playerRow(playerSourceByScorerId.get(id), now)),
      ['created_at']
    );
    const playerIdByScorerId = new Map(scorerIds.map((id, i) => [id, playerIds[i]]));

    await batchUpsert(
      db, 'player_external_ids', ['source', 'external_id'],
      scorerIds.map((id) => ({ player_id: playerIdByScorerId.get(id), source: 'fantrax', external_id: id }))
    );

    const rosterEntryRows = [];
    for (const t of fxTeams) {
      const teamId = teamIdByFantraxId[t.id];
      for (const p of rosterDataByFantraxTeam[t.id].players) {
        if (!p.scorerId) continue;
        rosterEntryRows.push({
          team_id: teamId, player_id: playerIdByScorerId.get(String(p.scorerId)), slot_id: null,
          status: mapRosterStatus(p.statusId),
          fantrax_status_id: p.statusId != null ? String(p.statusId) : null,
          is_rookie_season: p.rookie ? 1 : 0,
          acquired_at: now, acquired_via: 'import',
          created_at: now, updated_at: now,
        });
      }
    }
    await batchUpsert(db, 'roster_entries', ['team_id', 'player_id'], rosterEntryRows, ['created_at', 'acquired_at', 'acquired_via']);

    // ==================== future draft-pick ownership (roster data) ===========
    const futurePickAssetRows = [];
    for (const t of fxTeams) {
      const currentFranchiseId = franchiseIdByFantraxTeamId[t.id];
      for (const yearEntry of rosterDataByFantraxTeam[t.id].picks || []) {
        for (const d of yearEntry.detail || []) {
          futurePickAssetRows.push({
            draft_year: yearEntry.year, round: d.round,
            original_franchise_id: franchiseIdByFantraxTeamId[d.from] || currentFranchiseId,
            current_franchise_id: currentFranchiseId,
            draft_pick_id: null, created_at: now,
          });
        }
      }
    }
    await batchUpsert(db, 'draft_pick_assets', ['draft_year', 'round', 'original_franchise_id'], futurePickAssetRows, ['created_at', 'draft_pick_id']);

    // ================================ draft results =============================
    if (draftData) {
      const order = draftData.fantasyTeamsOrdered || [];
      const slotsPerRound = order.length || fxTeams.length;
      const picksOrdered = draftData.draftPicksOrdered || [];
      const rounds = picksOrdered.reduce((max, p) => Math.max(max, p.round), 0);
      const allDrafted = picksOrdered.length > 0 && picksOrdered.every((p) => p.scorerId);
      const anyDrafted = picksOrdered.some((p) => p.scorerId);

      const [draftClassId] = await batchUpsert(db, 'draft_classes', ['season_id'], [{
        season_id: seasonId, draft_type: 'rookie', rounds, slots_per_round: slotsPerRound,
        status: allDrafted ? 'complete' : anyDrafted ? 'in_progress' : 'scheduled',
        completed_at: null,
      }]);

      const franchiseIdBySlot = {};
      const draftOrderRows = [];
      for (let i = 0; i < order.length; i++) {
        const slot = i + 1;
        const teamId = teamIdByFantraxId[order[i].id];
        if (!teamId) continue;
        draftOrderRows.push({ draft_class_id: draftClassId, slot, team_id: teamId });
        franchiseIdBySlot[slot] = franchiseIdByFantraxTeamId[order[i].id];
      }
      await batchUpsert(db, 'draft_order', ['draft_class_id', 'slot'], draftOrderRows);

      const draftPickRows = [];
      for (const p of picksOrdered) {
        const teamId = teamIdByFantraxId[p.teamId];
        if (!teamId) { warnings.push(`draft pick R${p.round} slot ${p.pickNumber}: unknown team ${p.teamId}`); continue; }
        const overallPick = slotsPerRound ? (p.round - 1) * slotsPerRound + p.pickNumber : p.pickNumber;
        draftPickRows.push({
          draft_class_id: draftClassId, round: p.round, slot: p.pickNumber,
          overall_pick: overallPick, team_id: teamId,
          player_id: p.scorerId ? playerIdByScorerId.get(String(p.scorerId)) ?? null : null,
          drafted_at: null,
        });
      }
      const draftPickIds = await batchUpsert(db, 'draft_picks', ['draft_class_id', 'round', 'slot'], draftPickRows);

      const pickAssetRows = [];
      draftPickRows.forEach((row, i) => {
        const originalFranchiseId = franchiseIdBySlot[row.slot];
        if (!originalFranchiseId) return;
        pickAssetRows.push({
          draft_year: year, round: row.round, original_franchise_id: originalFranchiseId,
          current_franchise_id: franchiseIdByTeamId[row.team_id] || originalFranchiseId,
          draft_pick_id: draftPickIds[i], created_at: now,
        });
      });
      await batchUpsert(db, 'draft_pick_assets', ['draft_year', 'round', 'original_franchise_id'], pickAssetRows, ['created_at']);
    }

    // =================================== trades =================================
    // Preload lookups needed to resolve trade legs without a per-leg SELECT:
    // every (year, slot) -> original franchise (across ALL seasons imported so
    // far, not just this one), and every known player (globally, since a
    // traded player may not be on any current roster or this season's draft).
    const allPlayers = await all(db, 'SELECT id, fantrax_scorer_id, full_name, nba_team FROM players');
    const globalPlayerIdByScorerId = new Map(allPlayers.filter((p) => p.fantrax_scorer_id).map((p) => [p.fantrax_scorer_id, p.id]));
    for (const [scorerId, id] of playerIdByScorerId) globalPlayerIdByScorerId.set(scorerId, id);

    const slotFranchiseRows = await all(
      db,
      `SELECT s.year, do.slot, f.id as franchise_id
       FROM draft_order do
       JOIN draft_classes dc ON dc.id = do.draft_class_id
       JOIN seasons s ON s.id = dc.season_id
       JOIN teams t ON t.id = do.team_id
       JOIN franchises f ON f.id = t.franchise_id`
    );
    const franchiseIdByYearSlot = new Map(slotFranchiseRows.map((r) => [`${r.year}-${r.slot}`, r.franchise_id]));

    const tradeRowsToUpsert = trades.map((trade) => {
      const tradedAtMs = trade.date ? Date.parse(trade.date) : NaN;
      return {
        season_id: seasonId, fantrax_tx_set_id: String(trade.id),
        traded_at: Number.isFinite(tradedAtMs) ? tradedAtMs : now,
        week: trade.week != null ? parseInt(trade.week, 10) : null,
        notes: null, created_at: now,
      };
    });
    const tradeIds = await batchUpsert(db, 'trades', ['fantrax_tx_set_id'], tradeRowsToUpsert, ['created_at']);

    if (tradeIds.length) {
      await run(db, `DELETE FROM trade_legs WHERE trade_id IN (${tradeIds.map(() => '?').join(',')})`, ...tradeIds);
    }

    // Resolve every leg in memory first (may need to create new draft_pick_assets
    // for picks whose season hasn't been imported yet -- batched at the end).
    const newPickAssetRows = [];
    const resolvedLegs = []; // { tradeId, fromTeamId, toTeamId, assetType, playerId, pickAssetKey }
    for (let ti = 0; ti < trades.length; ti++) {
      const trade = trades[ti];
      const tradeId = tradeIds[ti];
      for (const leg of trade.legs) {
        const fromTeamId = teamIdByFantraxId[leg.fromId];
        const toTeamId = teamIdByFantraxId[leg.toId];
        if (!fromTeamId || !toTeamId) { warnings.push(`trade ${trade.id}: unresolved team on a leg`); continue; }
        const asset = leg.asset;

        if (asset.kind === 'player') {
          let playerId = asset.scorerId ? globalPlayerIdByScorerId.get(String(asset.scorerId)) : null;
          if (!playerId) {
            const match = allPlayers.find((p) => p.full_name === asset.name && (!asset.nbaTeam || p.nba_team === asset.nbaTeam));
            playerId = match?.id ?? null;
          }
          if (!playerId) { warnings.push(`trade ${trade.id}: could not resolve player "${asset.name}"`); continue; }
          resolvedLegs.push({ tradeId, fromTeamId, toTeamId, assetType: 'player', playerId });
        } else if (asset.kind === 'pick' && asset.round != null && asset.year != null) {
          let originalFranchiseId = asset.pick != null ? franchiseIdByYearSlot.get(`${asset.year}-${asset.pick}`) ?? null : null;
          if (originalFranchiseId == null && asset.origTeamName) {
            originalFranchiseId = matchFranchise(franchiseCandidates.concat(
              newFranchiseTeams.map((t, i) => ({ id: newFranchiseIds[i], name: t.name }))
            ), asset.origTeamName);
          }
          if (!originalFranchiseId) {
            warnings.push(`trade ${trade.id}: could not place pick (year ${asset.year}, round ${asset.round}) -- reconcile on a later re-import`);
            continue;
          }
          const key = `${asset.year}-${asset.round}-${originalFranchiseId}`;
          if (!newPickAssetRows.find((r) => r.__key === key)) {
            newPickAssetRows.push({
              __key: key,
              draft_year: asset.year, round: asset.round, original_franchise_id: originalFranchiseId,
              current_franchise_id: franchiseIdByTeamId[toTeamId] || originalFranchiseId,
              draft_pick_id: null, created_at: now,
            });
          }
          resolvedLegs.push({ tradeId, fromTeamId, toTeamId, assetType: 'pick', pickAssetKey: key });
        }
      }
    }

    let pickAssetIdByKey = new Map();
    if (newPickAssetRows.length) {
      const rows = newPickAssetRows.map(({ __key, ...rest }) => rest);
      const ids = await batchUpsert(db, 'draft_pick_assets', ['draft_year', 'round', 'original_franchise_id'], rows, ['created_at', 'draft_pick_id']);
      pickAssetIdByKey = new Map(newPickAssetRows.map((r, i) => [r.__key, ids[i]]));
    }

    const legParams = resolvedLegs.map((leg) => [
      leg.tradeId, leg.fromTeamId, leg.toTeamId, leg.assetType,
      leg.assetType === 'player' ? leg.playerId : null,
      leg.assetType === 'pick' ? pickAssetIdByKey.get(leg.pickAssetKey) : null,
    ]);
    await batchRun(
      db,
      `INSERT INTO trade_legs (trade_id, from_team_id, to_team_id, asset_type, player_id, draft_pick_asset_id)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      legParams
    );

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
