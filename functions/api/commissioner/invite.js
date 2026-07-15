// Cloudflare Pages Function — POST /api/commissioner/invite
//
// Session-gated (commissioner only). Creates a franchise_invites row and
// emails the invitee a claim link (/claim?token=...). Re-inviting an
// already-claimed franchise is allowed on purpose -- claiming overwrites
// owner_user_id, which doubles as the "fix a wrong claim" path.

import { json, first, run } from '../../_lib/db.js';
import { getSession, randomToken, hashToken } from '../../_lib/auth.js';
import { sendInviteEmail } from '../../_lib/email.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  const session = await getSession(context);
  if (!session || !session.user.isCommissioner) {
    return json({ error: 'Commissioners only.' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const franchiseId = parseInt(body?.franchiseId, 10);
  const email = String(body?.email || '').trim().toLowerCase();
  if (!franchiseId) return json({ error: 'franchiseId is required.' }, 400);
  if (!email) return json({ error: 'email is required.' }, 400);

  const franchise = await first(env.DB, 'SELECT id, name FROM franchises WHERE id = ?', franchiseId);
  if (!franchise) return json({ error: `No franchise with id ${franchiseId}.` }, 404);

  const token = randomToken();
  const now = Date.now();
  const { meta } = await run(
    env.DB,
    'INSERT INTO franchise_invites (franchise_id, email, token_hash, invited_by_user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    franchiseId,
    email,
    await hashToken(token),
    session.user.id,
    now + INVITE_TTL_MS,
    now
  );

  const link = `${new URL(request.url).origin}/claim?token=${token}`;
  try {
    await sendInviteEmail(env, email, link, franchise.name);
  } catch (e) {
    // Unlike request-link.js's public/enumeration-sensitive endpoint, this
    // one is commissioner-only and authenticated -- a failed send should be
    // visible, not swallowed. Delete the now-dead invite row (its raw token
    // was never delivered to anyone, so it can never be claimed) rather than
    // leaving an orphan that looks like a sent invite on inspection.
    await run(env.DB, 'DELETE FROM franchise_invites WHERE id = ?', meta.last_row_id);
    const msg = (e && e.message) || String(e);
    return json({ error: `Failed to send invite email: ${msg}` }, 502);
  }

  return json({ ok: true });
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
