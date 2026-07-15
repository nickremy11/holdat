// Magic-link auth helpers shared by functions/api/auth/*.js and, later, any
// write endpoint that needs to check "can this session act on this team".

import { first, run } from './db.js';

const COOKIE_NAME = 'holdat_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function hashToken(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function cookieHeader(token, { maxAgeSeconds = SESSION_TTL_MS / 1000 } = {}) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function getSessionToken(request) {
  return readCookie(request, COOKIE_NAME);
}

// Creates a magic_link_tokens row for userId, returns the raw (unhashed) token.
export async function createMagicLinkToken(db, userId, requestIp) {
  const token = randomToken();
  const now = Date.now();
  await run(
    db,
    'INSERT INTO magic_link_tokens (user_id, token_hash, expires_at, created_at, requested_ip) VALUES (?, ?, ?, ?, ?)',
    userId,
    await hashToken(token),
    now + MAGIC_LINK_TTL_MS,
    now,
    requestIp || null
  );
  return token;
}

// Creates a sessions row for userId, returns the raw (unhashed) session
// token. Shared by consumeMagicLinkToken (below) and the invite-claim flow
// (functions/api/auth/claim.js), which also needs a session the moment a
// franchise invite is claimed.
export async function createSession(db, userId) {
  const now = Date.now();
  const sessionToken = randomToken();
  await run(
    db,
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
    userId,
    await hashToken(sessionToken),
    now,
    now + SESSION_TTL_MS
  );
  return sessionToken;
}

// Consumes a magic-link token (if valid/unexpired/unconsumed) and creates a
// new session. Returns the raw session token, or null if the link is invalid.
export async function consumeMagicLinkToken(db, rawToken) {
  const tokenHash = await hashToken(rawToken);
  const now = Date.now();
  const row = await first(
    db,
    'SELECT id, user_id FROM magic_link_tokens WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?',
    tokenHash,
    now
  );
  if (!row) return null;

  await run(db, 'UPDATE magic_link_tokens SET consumed_at = ? WHERE id = ?', now, row.id);
  await run(db, 'UPDATE users SET last_login_at = ? WHERE id = ?', now, row.user_id);

  return createSession(db, row.user_id);
}

export async function destroySession(db, rawToken) {
  if (!rawToken) return;
  await run(db, 'DELETE FROM sessions WHERE token_hash = ?', await hashToken(rawToken));
}

// Resolves the current request's session cookie to { user, franchise } or
// null. franchise is null for a user who doesn't own a franchise (e.g. a
// commissioner-only account). This is the one join every future write
// endpoint's authorization check builds on.
export async function getSession(context) {
  const raw = readCookie(context.request, COOKIE_NAME);
  if (!raw) return null;

  const tokenHash = await hashToken(raw);
  const now = Date.now();
  const row = await first(
    context.env.DB,
    `SELECT
       u.id AS user_id, u.email, u.display_name, u.is_commissioner,
       f.id AS franchise_id, f.name AS franchise_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN franchises f ON f.owner_user_id = u.id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    tokenHash,
    now
  );
  if (!row) return null;

  run(context.env.DB, 'UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now, tokenHash).catch(() => {});

  return {
    user: { id: row.user_id, email: row.email, displayName: row.display_name, isCommissioner: !!row.is_commissioner },
    franchise: row.franchise_id ? { id: row.franchise_id, name: row.franchise_name } : null,
  };
}

// Resolves the session only if it belongs to a commissioner, else null.
// Every functions/api/commissioner/*.js endpoint gates on this.
export async function getCommissionerSession(context) {
  const session = await getSession(context);
  return session && session.user.isCommissioner ? session : null;
}

// True if `session` may act on behalf of `franchiseId` (own it, or be commissioner).
export function canActOnFranchise(session, franchiseId) {
  if (!session) return false;
  if (session.user.isCommissioner) return true;
  return session.franchise?.id === franchiseId;
}
