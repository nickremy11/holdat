// Cloudflare Pages Function — /api/bbm
//
// Scrapes Basketball Monster's Player Rankings page (which the user has configured
// to show the "BZ" = Bazemore dynasty value column, scoped to their HOLDAT league)
// and returns a compact { normalizedName: bzValue } map.
//
// Auth: a logged-in BBM session cookie, stored as env.BBM_COOKIE
//   (ASP.NET_SessionId=...; RotoMonsterUserId=...). Server-side only.
//   Set via: wrangler pages secret put BBM_COOKIE
//
// A plain GET returns the account's saved view (HOLDAT league + BZ column), so no
// form/viewstate replay is needed. Cached ~6h via the Cache API.

const BBM_URL = 'https://basketballmonster.com/playerrankings.aspx';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';

// Column indexes in each player <tr> (see the rankings table layout):
//   7 = BZ (Bazemore value, e.g. "236.01#1"), 10 = Name, 11 = Team
const COL_BZ = 7, COL_NAME = 10, COL_TEAM = 11;

const CACHE_SECONDS = 6 * 3600;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function cellText(htmlFrag) {
  return decodeEntities(htmlFrag.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Shared name key — must match the client's normName().
export function normName(s) {
  return decodeEntities(String(s || ''))
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')      // strip accents
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')               // drop suffixes
    .replace(/[^a-z0-9]/g, '');                            // keep alnum only
}

// Parse the rankings HTML into { normName: bzValue }. Row-by-row split avoids
// catastrophic regex backtracking on the ~1.3MB page.
function parseBZ(html) {
  const out = {};
  const segments = html.split(/<tr[\s>]/i);
  for (const seg of segments) {
    const end = seg.indexOf('</tr>');
    const rowHtml = end >= 0 ? seg.slice(0, end) : seg;
    const cells = [];
    const re = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let m;
    while ((m = re.exec(rowHtml)) !== null) cells.push(m[1]);
    if (cells.length <= COL_TEAM) continue;

    const name = cellText(cells[COL_NAME]);
    const team = cellText(cells[COL_TEAM]);
    const bzRaw = cellText(cells[COL_BZ]);
    if (!/^[A-Za-z]/.test(name)) continue;       // real player name
    if (!/^[A-Z]{2,3}$/.test(team)) continue;    // real NBA team cell
    const mb = bzRaw.match(/-?\d+(?:\.\d+)?/);   // "236.01#1" -> 236.01
    if (!mb) continue;
    out[normName(name)] = parseFloat(mb[0]);
  }
  return out;
}

// current value of a <select name="X"> (its selected <option>) on the page
function selectedValue(html, name) {
  const sel = new RegExp(`<select[^>]*name=['"]?${name}['"]?[^>]*>([\\s\\S]*?)</select>`, 'i').exec(html);
  if (!sel) return null;
  const o = /<option[^>]*\bselected\b[^>]*value=['"]?([^'"\s>]+)/i.exec(sel[1])
    || /<option[^>]*value=['"]?([^'"\s>]+)['"]?[^>]*\bselected\b/i.exec(sel[1]);
  return o ? decodeEntities(o[1]) : null;
}
// current value of a text/hidden <input name="X">
function inputValue(html, name) {
  const tag = new RegExp(`<input[^>]*name=['"]?${name}['"]?[^>]*>`, 'i').exec(html);
  if (!tag) return null;
  const v = /value=['"]([^'"]*)['"]/i.exec(tag[0]);
  return v ? decodeEntities(v[1]) : null;
}

// Build the form post that re-renders the rankings with PlayerFilterControl=AllPlayers,
// reusing the GET page's fresh __VIEWSTATE and inheriting the saved control values.
function buildAllPlayersBody(getHtml, env) {
  const p = new URLSearchParams();
  // all hidden fields (viewstate, generator, etc.) — must be fresh from the GET
  const re = /<input[^>]*type=['"]?hidden['"]?[^>]*>/gi;
  let m;
  while ((m = re.exec(getHtml)) !== null) {
    const nm = /name=['"]([^'"]+)['"]/.exec(m[0]);
    const vl = /value=['"]([^'"]*)['"]/.exec(m[0]);
    if (nm) p.set(nm[1], vl ? decodeEntities(vl[1]) : '');
  }
  const pick = (name, def) => selectedValue(getHtml, name) ?? inputValue(getHtml, name) ?? def;
  p.set('__EVENTTARGET', 'PlayerFilterControl');
  p.set('__EVENTARGUMENT', '');
  p.set('ctl00$MasterNameTB', '');
  p.set('LeagueDropDown', env.BBM_LEAGUE_ID || pick('LeagueDropDown', '13474'));
  p.set('DataSetControl', pick('DataSetControl', '160'));
  p.set('DateFilterControl', pick('DateFilterControl', 'FullSeason'));
  p.set('ValueDisplayType', pick('ValueDisplayType', 'PerGame'));
  p.set('StatDisplayType', pick('StatDisplayType', 'StatDisplayTypeG'));
  p.set('DynastyControlField', pick('DynastyControlField', 'TotalValue'));
  p.set('DynastyControlRC', env.BBM_RC || pick('DynastyControlRC', '1.25'));
  p.set('PlayerFilterControl', 'AllPlayers');
  ['3', '4', '5', '6', '7'].forEach((n) => p.set('PositionsFilterControl' + n, 'on'));
  p.set('TeamFilterControl', '0');
  p.set('HomeAwayFilterControl', 'HA');
  p.set('BoxScoreTagFilterControlId', '-1');
  return p.toString();
}

const KV_KEY = 'bz_map_v1';

// Live-scrape Basketball Monster -> { players, count, fetchedAt } or { error, status }.
async function scrapeBBM(env) {
  const cookie = env.BBM_COOKIE;
  if (!cookie) return { error: 'BBM_COOKIE secret is not set on this Pages project.', status: 500 };
  const loggedOut = (h) => !/Player Rankings/i.test(h) || !/>BZ</.test(h);
  try {
    // 1) GET the saved view (HOLDAT league + BZ column) to grab a fresh viewstate.
    const getRes = await fetch(BBM_URL, { headers: { Cookie: cookie, 'User-Agent': UA } });
    if (!getRes.ok) return { error: `Basketball Monster HTTP ${getRes.status}`, status: 502 };
    const getHtml = await getRes.text();
    if (loggedOut(getHtml)) {
      return { error: 'Basketball Monster session expired. Refresh the BBM_COOKIE secret.', code: 'NOT_LOGGED_IN', status: 401 };
    }
    // 2) Re-post the form flipping the player filter to "All Players" (~580 vs ~370).
    const body = buildAllPlayersBody(getHtml, env);
    const postRes = await fetch(BBM_URL, {
      method: 'POST',
      headers: {
        Cookie: cookie, 'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://basketballmonster.com', Referer: BBM_URL,
      },
      body,
    });
    const postHtml = await postRes.text();
    const html = (!postRes.ok || loggedOut(postHtml)) ? getHtml : postHtml;
    const players = parseBZ(html);
    if (!Object.keys(players).length) return { error: 'Parsed 0 players from Basketball Monster.', status: 502 };
    return { players, count: Object.keys(players).length, fetchedAt: Date.now() };
  } catch (e) {
    return { error: `Fetch failed: ${(e && e.message) || e}`, status: 502 };
  }
}

async function refreshKV(env) {
  const data = await scrapeBBM(env);
  if (data.error) return data;
  if (env.BBM_KV) await env.BBM_KV.put(KV_KEY, JSON.stringify(data));
  return data;
}

// GET /api/bbm                     -> read shared BZ map from KV (visitors never scrape)
// GET /api/bbm?refresh=<token>     -> re-scrape BBM + write KV  (token = env.BBM_REFRESH_TOKEN)
export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const refresh = url.searchParams.get('refresh');

  // Token-protected manual refresh (run every few months when BZ updates).
  if (refresh != null) {
    if (!env.BBM_REFRESH_TOKEN || refresh !== env.BBM_REFRESH_TOKEN) {
      return json({ error: 'Invalid or missing refresh token.' }, 403);
    }
    const data = await refreshKV(env);
    if (data.error) return json({ error: data.error, code: data.code }, data.status || 502);
    return json({ ok: true, count: data.count, fetchedAt: data.fetchedAt, stored: !!env.BBM_KV });
  }

  // Normal read: serve the shared map from KV.
  if (env.BBM_KV) {
    const cached = await env.BBM_KV.get(KV_KEY);
    if (cached) {
      return new Response(cached, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
        },
      });
    }
  }

  // KV empty (first ever load) — lazily populate it if the cookie is available.
  const data = await refreshKV(env);
  if (data.error) return json({ error: data.error, code: data.code }, data.status || 502);
  return json(data, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
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
