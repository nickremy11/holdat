// Cloudflare Pages Function — /api/fantrax
//
// Proxies Fantrax's internal /fxpa/req endpoint using a stored session cookie,
// then parses the verbose responses into compact JSON the page can use directly.
//
// Cookie is read from env.FANTRAX_COOKIE (set via: wrangler pages secret put FANTRAX_COOKIE).
//
// Routes (all GET):
//   /api/fantrax?league={id}              -> { league, categories, teams:[...] }  (everything)
//   /api/fantrax?league={id}&type=teams   -> raw getFantasyTeams
//   /api/fantrax?league={id}&type=trades  -> { league, trades:[...] }  (executed trade history)
//   /api/fantrax?league={id}&type=raw&method={m} -> raw passthrough (debug)

const FX_URL = 'https://www.fantrax.com/fxpa/req';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 9-cat scoring categories we care about, by Fantrax column shortName.
const CATS = ['FG%', '3PTM', 'FT%', 'PTS', 'REB', 'AST', 'ST', 'BLK', 'TO'];
// Categories where a LOWER value is better (only turnovers here).
const LOWER_BETTER = new Set(['TO']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

async function fxReq(method, data, cookie) {
  const res = await fetch(`${FX_URL}?leagueId=${encodeURIComponent(data.leagueId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Cookie: cookie,
    },
    body: JSON.stringify({ msgs: [{ method, data }] }),
  });
  if (!res.ok) throw new Error(`Fantrax ${method} HTTP ${res.status}`);
  const j = await res.json();
  const resp = j.responses && j.responses[0];
  const err = (resp && resp.pageError) || j.pageError;
  if (err && err.code && err.code !== 'WARNING_NOT_LOGGED_IN') {
    // surface real errors; treat not-logged-in as fatal too (no data anyway)
    throw new Error(`Fantrax ${method}: ${err.code}${err.text ? ' — ' + stripTags(err.text) : ''}`);
  }
  if (err && err.code === 'WARNING_NOT_LOGGED_IN') {
    throw new Error('FANTRAX_NOT_LOGGED_IN');
  }
  return resp && resp.data;
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function num(v) {
  if (v == null || v === '' || v === '-') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Parse one team's getTeamRosterInfo into { players:[...], picks:[...] }
function parseRoster(data) {
  const out = { players: [], picks: [] };
  if (!data) return out;

  const table = data.tables && data.tables[0];
  if (table && table.header && table.rows) {
    const cols = table.header.cells || [];
    // Map: cell index -> our category key (or 'age')
    const colMap = {};
    cols.forEach((c, i) => {
      const sn = c.shortName || c.name;
      if (sn === 'Age') colMap[i] = '__age';
      else if (CATS.includes(sn)) colMap[i] = sn;
      else if (sn === 'GP') colMap[i] = '__gp';
    });

    for (const row of table.rows) {
      const sc = row.scorer;
      if (!sc) continue; // empty slot / header row
      const cells = row.cells || [];
      const stats = {};
      let age = null, gp = null;
      Object.keys(colMap).forEach((i) => {
        const key = colMap[i];
        const val = num(cells[i] && cells[i].content);
        if (key === '__age') age = val;
        else if (key === '__gp') gp = val;
        else stats[key] = val;
      });
      out.players.push({
        name: sc.name,
        shortName: sc.shortName,
        scorerId: sc.scorerId,
        nbaTeam: sc.teamShortName || null,
        nbaTeamName: sc.teamName || null,
        pos: sc.posShortNames || '',          // e.g. "SG,G,SF,F"
        posIds: sc.posIds || [],
        headshot: sc.headshotUrl || null,
        rookie: !!sc.rookie,
        age,
        gp,
        statusId: row.statusId || null,        // active vs reserve/IR slot
        slotPosId: row.posId || null,
        stats,
      });
    }
  }

  // Draft picks owned by this team
  const dp = data.draftPicksData;
  if (dp && Array.isArray(dp.draftPicksPerYear)) {
    for (const y of dp.draftPicksPerYear) {
      const list = y.draftPickList || [];
      out.picks.push({
        year: y.year,
        rounds: list.map((p) => p.round),
        detail: list.map((p) => ({ round: p.round, from: p.origOwnerTeamId })),
      });
    }
  }
  return out;
}

// Parse getTransactionDetailsHistory rows into { id, date, week, teams:[id,...], legs:[...] }.
// Each source row = one asset moving from one team to another; rows sharing a
// txSetId belong to the same trade. Assets are either a player (row.scorer) or a
// draft pick (row.draftPickDisplayParts — HTML-ish "Round <b>1</b> Pick <b>1</b>" /
// "<b>2026</b> Draft Pick", parsed with regex since Fantrax doesn't give it structured here).
function parsePickLabel(dp) {
  const strip = (s) => stripTags(s || '');
  const roundInfo = strip(dp.roundInfo);
  const year = (strip(dp.year).match(/\d{4}/) || [])[0] || null;
  const round = (roundInfo.match(/Round\s*(\d+)/i) || [])[1];
  const pick = (roundInfo.match(/Pick\s*(\d+)/i) || [])[1];
  // When the slot isn't determined yet, Fantrax shows the original-owner team name
  // in parens instead of a pick number, e.g. "Round 2 (KC Voyagers)" — this is what
  // lets us resolve who was drafted once that team's slot is known (see resolveDraftedPicks).
  const origTeamName = pick ? null : (roundInfo.match(/\(([^)]+)\)/) || [])[1] || null;
  return {
    year: year ? parseInt(year, 10) : null,
    round: round ? parseInt(round, 10) : null,
    pick: pick ? parseInt(pick, 10) : null,
    origTeamName,
  };
}

// A traded pick's YEAR uniquely identifies which league ran that draft — each
// dynasty "season" is its own Fantrax league ID, and its own upcoming/most-recent
// rookie draft is labeled by the calendar year it happens in (e.g. the 26-27 league's
// draft is "2026"). Confirmed empirically: 24-25 league's draft picks are dated 2024,
// 25-26 league's are dated 2025, etc. Extend this map when a new season league is added.
const YEAR_TO_LEAGUE = {
  2023: 'qybhh93dlge64jyi', // 23-24 season league — 22-round startup draft
  2024: 'uxe3kqislwu07xfm', // 24-25 season league
  2025: 'zdmn1wu0md6fpz8d', // 25-26 season league
  2026: 'mkuoaxbhmqrct7rf', // 26-27 season league
};

// Mutates trades' pick assets in place, attaching `.drafted = {name, pos, nbaTeam, headshot}`
// wherever we can resolve who was actually selected with that pick. Two cases:
//   A) the trade already shows an explicit slot ("Pick N") — the slot number Fantrax
//      uses is stable, so it maps directly onto that draft-year league's results.
//   B) the trade shows the ORIGINAL OWNER's name in parens (slot undetermined at trade
//      time) — find that team's slot via the target league's own draft-order list, then
//      look up that (round, slot) the same way.
// Picks whose draft hasn't happened yet (no scorerId on that slot) are left unresolved.
async function resolveDraftedPicks(trades, cookie) {
  const neededYears = new Set();
  for (const t of trades) for (const leg of t.legs) {
    const a = leg.asset;
    if (a.kind === 'pick' && a.year != null && YEAR_TO_LEAGUE[a.year]) neededYears.add(a.year);
  }
  if (!neededYears.size) return;

  const draftByLeague = {};
  await Promise.all([...neededYears].map(async (year) => {
    const lgId = YEAR_TO_LEAGUE[year];
    try {
      const dr = await fxReq('getDraftResults', { leagueId: lgId }, cookie);
      const order = (dr && dr.fantasyTeamsOrdered) || [];
      const slotByTeamName = {};
      order.forEach((t, i) => { slotByTeamName[t.name.trim().toLowerCase()] = i + 1; });
      const pickKeyToScorer = {};
      for (const p of (dr && dr.draftPicksOrdered) || []) {
        if (p.scorerId) pickKeyToScorer[`${p.round}-${p.pickNumber}`] = p.scorerId;
      }
      const scorerById = {};
      for (const s of (dr && dr.scorers) || []) scorerById[s.scorerId] = s;
      draftByLeague[year] = { slotByTeamName, pickKeyToScorer, scorerById };
    } catch (e) { /* leave this year's picks unresolved */ }
  }));

  for (const t of trades) for (const leg of t.legs) {
    const a = leg.asset;
    if (a.kind !== 'pick' || a.round == null) continue;
    const dl = draftByLeague[a.year];
    if (!dl) continue;
    let slot = a.pick;
    if (slot == null && a.origTeamName) {
      const key = a.origTeamName.trim().toLowerCase();
      slot = dl.slotByTeamName[key] ?? null;
      // Teams sometimes rename between seasons (e.g. "KC Voyagers" -> "Voyagers").
      // Fall back to a substring match, but only when it's unambiguous.
      if (slot == null) {
        const hits = Object.keys(dl.slotByTeamName).filter((n) => n.includes(key) || key.includes(n));
        if (hits.length === 1) slot = dl.slotByTeamName[hits[0]];
      }
    }
    if (slot == null) continue;
    const scorerId = dl.pickKeyToScorer[`${a.round}-${slot}`];
    const sc = scorerId && dl.scorerById[scorerId];
    if (sc && sc.name) {
      a.drafted = { name: sc.name, pos: sc.posShortNames || '', nbaTeam: sc.teamShortName || null, headshot: sc.headshotUrl || null };
    }
  }
}

function parseTrades(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.txSetId) continue;
    (groups.get(row.txSetId) || groups.set(row.txSetId, []).get(row.txSetId)).push(row);
  }

  const trades = [];
  for (const [txSetId, grp] of groups) {
    let date = null, week = null;
    const teamIds = new Set();
    const teamNames = {};
    const legs = [];
    for (const row of grp) {
      const cells = {};
      for (const c of row.cells || []) cells[c.key] = c;
      if (cells.date && cells.date.content) date = cells.date.content;
      if (cells.week && cells.week.content != null) week = cells.week.content;
      const fromId = cells.from && cells.from.teamId, toId = cells.to && cells.to.teamId;
      if (fromId) { teamIds.add(fromId); teamNames[fromId] = cells.from.content; }
      if (toId) { teamIds.add(toId); teamNames[toId] = cells.to.content; }

      const sc = row.scorer;
      let asset = null;
      if (sc && sc.name) {
        asset = {
          kind: 'player', name: sc.name, pos: sc.posShortNames || '',
          nbaTeam: sc.teamShortName || null, headshot: sc.headshotUrl || null,
        };
      } else if (row.draftPickDisplayParts) {
        const p = parsePickLabel(row.draftPickDisplayParts);
        asset = { kind: 'pick', year: p.year, round: p.round, pick: p.pick, origTeamName: p.origTeamName };
      }
      if (asset && fromId && toId) legs.push({ fromId, toId, asset });
    }
    if (!legs.length) continue;
    trades.push({ id: txSetId, date, week, teamIds: [...teamIds], teamNames, legs });
  }
  // newest first (date strings are "Mon DD, YYYY, H:MMAM/PM" — sort by original row order instead,
  // which getTransactionDetailsHistory already returns newest-first)
  return trades;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const league = url.searchParams.get('league');
  const type = url.searchParams.get('type') || 'all';
  const cookie = env.FANTRAX_COOKIE;

  if (!cookie) return json({ error: 'FANTRAX_COOKIE secret is not set on this Pages project.' }, 500);
  if (!league) return json({ error: 'Missing ?league= param.' }, 400);

  try {
    if (type === 'raw') {
      const method = url.searchParams.get('method');
      const team = url.searchParams.get('team');
      const data = { leagueId: league };
      if (team) data.teamId = team;
      const out = await fxReq(method, data, cookie);
      return json(out);
    }

    if (type === 'trades') {
      const rows = [];
      let page = 1, totalPages = 1;
      do {
        const out = await fxReq('getTransactionDetailsHistory', {
          leagueId: league, view: 'TRADE', pageNumber: page, maxResultsPerPage: 100,
        }, cookie);
        const tbl = out && out.table;
        rows.push(...((tbl && tbl.rows) || []));
        totalPages = (out && out.paginatedResultSet && out.paginatedResultSet.totalNumPages) || 1;
        page += 1;
      } while (page <= totalPages && page <= 10); // safety cap
      const trades = parseTrades(rows);
      await resolveDraftedPicks(trades, cookie);
      return json({ league, trades, fetchedAt: Date.now() });
    }

    if (type === 'teams') {
      const out = await fxReq('getFantasyTeams', { leagueId: league }, cookie);
      return json(out);
    }

    // type === 'all' — assemble everything
    const [teamsData, standingsData, draftData] = await Promise.all([
      fxReq('getFantasyTeams', { leagueId: league }, cookie),
      fxReq('getStandings', { leagueId: league }, cookie),
      fxReq('getDraftResults', { leagueId: league }, cookie).catch(() => null),
    ]);

    const teams = (teamsData.fantasyTeams || []).map((t) => ({
      id: t.id,
      name: t.name,
      shortName: t.shortName,
      logo: t.logoUrl128 || t.logoUrl256 || null,
    }));

    // Standings -> rank + record per teamId
    const standMap = {};
    const tl = standingsData.tableList && standingsData.tableList[0];
    if (tl && tl.rows) {
      const hdr = (tl.header.cells || []).map((c) => c.shortName || c.name);
      for (const row of tl.rows) {
        const fixed = row.fixedCells || [];
        const rank = num(fixed[0] && fixed[0].content);
        const teamId = fixed[1] && fixed[1].teamId;
        if (!teamId) continue;
        const cells = row.cells || [];
        const rec = {};
        hdr.forEach((h, i) => { rec[h] = cells[i] && cells[i].content; });
        standMap[teamId] = {
          rank,
          w: num(rec['W']), l: num(rec['L']), t: num(rec['T']),
          winPct: rec['Win%'], ptsF: num(rec['PtsF']), ptsA: num(rec['PtsA']),
        };
      }
    }

    // Fetch every team's roster in parallel
    const rosters = await Promise.all(
      teams.map((t) => fxReq('getTeamRosterInfo', { leagueId: league, teamId: t.id }, cookie))
    );

    const rosterPicksByTeam = {};
    teams.forEach((t, i) => {
      const parsed = parseRoster(rosters[i]);
      t.players = parsed.players;
      rosterPicksByTeam[t.id] = parsed.picks; // year-based, no slots — used for future years
      const s = standMap[t.id] || {};
      t.rank = s.rank ?? null;
      t.record = { w: s.w, l: s.l, t: s.t, winPct: s.winPct, ptsF: s.ptsF, ptsA: s.ptsA };
    });

    // --- Draft: real slots for the upcoming draft (getDraftResults), round-only for future years ---
    const order = (draftData && draftData.fantasyTeamsOrdered) || [];
    const slotsPerRound = order.length || teams.length || 0;
    // slot (1-based draft order) -> the team that ORIGINALLY owns that slot
    const slotOriginalOwner = {};
    order.forEach((t, i) => { slotOriginalOwner[i + 1] = t.id; });

    // current draft year = earliest year present in the roster pick data
    let currentYear = null;
    Object.values(rosterPicksByTeam).forEach((arr) => {
      (arr || []).forEach((y) => { if (currentYear == null || y.year < currentYear) currentYear = y.year; });
    });

    // current-draft picks (with slots) grouped by current owner
    const currentByTeam = {};
    if (draftData && Array.isArray(draftData.draftPicksOrdered)) {
      for (const p of draftData.draftPicksOrdered) {
        const orig = slotOriginalOwner[p.pickNumber];
        (currentByTeam[p.teamId] = currentByTeam[p.teamId] || []).push({
          round: p.round,
          slot: p.pickNumber,
          overall: slotsPerRound ? (p.round - 1) * slotsPerRound + p.pickNumber : p.pickNumber,
          acquired: !!(orig && orig !== p.teamId),
        });
      }
    }
    Object.values(currentByTeam).forEach((a) => a.sort((x, y) => x.round - y.round || x.slot - y.slot));

    teams.forEach((t) => {
      const current = currentByTeam[t.id] || [];
      // future-year picks (no slots yet): everything in roster data beyond the current draft year
      const future = (rosterPicksByTeam[t.id] || [])
        .filter((y) => currentYear == null || y.year > currentYear)
        .map((y) => ({
          year: y.year,
          rounds: y.rounds || [],
          acquiredRounds: (y.detail || []).filter((d) => d.from && d.from !== t.id).map((d) => d.round),
        }));
      t.draft = { currentYear, current, future };
    });

    return json({
      league,
      categories: CATS,
      lowerBetter: [...LOWER_BETTER],
      slotsPerRound,
      draftCurrentYear: currentYear,
      teams,
      fetchedAt: Date.now(),
    });
  } catch (e) {
    const msg = e && e.message || String(e);
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
