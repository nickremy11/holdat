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

    if (type === 'teams') {
      const out = await fxReq('getFantasyTeams', { leagueId: league }, cookie);
      return json(out);
    }

    // type === 'all' — assemble everything
    const [teamsData, standingsData] = await Promise.all([
      fxReq('getFantasyTeams', { leagueId: league }, cookie),
      fxReq('getStandings', { leagueId: league }, cookie),
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

    teams.forEach((t, i) => {
      const parsed = parseRoster(rosters[i]);
      t.players = parsed.players;
      t.picks = parsed.picks;
      const s = standMap[t.id] || {};
      t.rank = s.rank ?? null;
      t.record = { w: s.w, l: s.l, t: s.t, winPct: s.winPct, ptsF: s.ptsF, ptsA: s.ptsA };
    });

    return json({
      league,
      categories: CATS,
      lowerBetter: [...LOWER_BETTER],
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
