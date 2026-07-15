// Cloudflare Pages Function — GET /api/commissioner/franchises
//
// Session-gated (not token-gated like functions/api/admin/franchises.js) --
// this powers the in-app /commissioner panel, so it must not require the
// ADMIN_IMPORT_TOKEN secret to ever reach the browser. Same query shape as
// the admin version; duplicated rather than shared since it's five lines.

import { json, all } from '../../_lib/db.js';
import { getCommissionerSession } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  if (!context.env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  const session = await getCommissionerSession(context);
  if (!session) return json({ error: 'Commissioners only.' }, 403);

  const franchises = await all(
    context.env.DB,
    `SELECT f.id, f.name, u.email, u.display_name
     FROM franchises f
     LEFT JOIN users u ON u.id = f.owner_user_id
     ORDER BY f.name`
  );

  return json({ franchises });
}
