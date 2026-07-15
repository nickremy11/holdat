// Shared across index.html / trades.html (no build step — plain <script> include).
const API = '/api/fantrax';
const LEAGUES = [
  { id: 'mkuoaxbhmqrct7rf', label: '26-27 Dynasty' },
  { id: 'zdmn1wu0md6fpz8d', label: '25-26 (History)' },
  { id: 'uxe3kqislwu07xfm', label: '24-25 (History)' },
  { id: 'qybhh93dlge64jyi', label: '23-24 (History)' },
];

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const qparam = (k) => new URLSearchParams(location.search).get(k);
// display-only: drop the generic G/F slots (implied by PG/SG/SF/PF); keep PG,SG,SF,PF,C
const displayPos = (pos) => String(pos || '').split(',').map(s => s.trim())
  .filter(p => p && p !== 'G' && p !== 'F').join(',');

function curLeague() {
  return qparam('league') || LEAGUES[0].id;
}

// Populates #lgSwitch + #subLabel and wires navigation that preserves the current
// page path (so switching leagues on /trades stays on /trades).
function setupLeagueSwitcher() {
  const sel = $('#lgSwitch');
  if (!sel) return;
  sel.innerHTML = LEAGUES.map(l => `<option value="${l.id}">${l.label}</option>`).join('');
  sel.value = curLeague();
  const found = LEAGUES.find(l => l.id === sel.value);
  const sub = $('#subLabel');
  if (found && sub) sub.textContent = found.label;
  sel.onchange = () => {
    const u = new URL(location.href); u.searchParams.set('league', sel.value);
    location.href = u.toString();
  };
}

// Populates #authNav with "Log in" (logged out) or "{name} · Log out" (logged
// in), reused by every page's header .controls div.
async function setupAuthNav() {
  const el = $('#authNav');
  if (!el) return;
  let session = null;
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) session = await res.json();
  } catch {}

  if (!session) {
    el.innerHTML = `<a href="/login">Log in</a>`;
    return;
  }
  const commissionerLink = session.user.isCommissioner ? `<a href="/commissioner">Commissioner</a> · ` : '';
  el.innerHTML = `${esc(session.user.displayName)} · ${commissionerLink}<a href="#" id="logoutLink">Log out</a>`;
  $('#logoutLink', el).onclick = async (e) => {
    e.preventDefault();
    await fetch('/api/auth/logout', { method: 'POST' });
    location.reload();
  };
}
