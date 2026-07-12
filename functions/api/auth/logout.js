// Cloudflare Pages Function — POST /api/auth/logout
//
// Deletes the current session row (if any) and clears the cookie.

import { json } from '../../_lib/db.js';
import { destroySession, getSessionToken, clearCookieHeader } from '../../_lib/auth.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  if (env.DB) {
    const token = getSessionToken(request);
    if (token) await destroySession(env.DB, token);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Set-Cookie': clearCookieHeader(),
    },
  });
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
