// Cloudflare Pages Function — POST /api/auth/request-link
//
// { email } -> looks up the user, and if found (and under the rate limit)
// emails a 15-minute magic login link. Always returns the same generic 200
// whether or not the email matched, so this endpoint can't be used to
// enumerate registered emails.

import { json, first } from '../../_lib/db.js';
import { createMagicLinkToken } from '../../_lib/auth.js';
import { sendMagicLinkEmail } from '../../_lib/email.js';

const RATE_LIMIT_PER_HOUR = 5;

async function underRateLimit(env, email) {
  if (!env.BBM_KV) return true; // no KV bound locally -> don't block dev
  const key = `authrl:${email}`;
  const raw = await env.BBM_KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= RATE_LIMIT_PER_HOUR) return false;
  await env.BBM_KV.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const email = String(body?.email || '').trim().toLowerCase();
  if (!email) return json({ error: 'email is required.' }, 400);

  try {
    const user = await first(env.DB, 'SELECT id FROM users WHERE email = ?', email);
    if (user && (await underRateLimit(env, email))) {
      const token = await createMagicLinkToken(env.DB, user.id, request.headers.get('CF-Connecting-IP'));
      const link = `${new URL(request.url).origin}/api/auth/verify?token=${token}`;
      await sendMagicLinkEmail(env, email, link);
    }
  } catch (e) {
    // Swallowed deliberately: this endpoint's response never reveals whether
    // the email matched or whether sending succeeded. Logged server-side only
    // (e.g. a stale RESEND_API_KEY fails silently otherwise, with no trace
    // anywhere) so real send failures are still debuggable via wrangler/CF logs.
    console.error('request-link failed:', e);
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
