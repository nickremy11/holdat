// Cloudflare Pages Function — GET /api/commissioner/settings
//
// Session-gated (commissioner only). Returns everything settings.html needs
// in one call: league name, the active season's season_settings row, its
// scoring_categories, its lineup_slots, and its divisions (with assigned
// team ids) -- always for the active season, never a frozen historical one.

import { json, all, first, getActiveSeasonId } from '../../_lib/db.js';
import { getCommissionerSession } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.DB) return json({ error: 'DB is not configured on this Pages project.' }, 500);

  const session = await getCommissionerSession(context);
  if (!session) return json({ error: 'Commissioners only.' }, 403);

  const seasonId = await getActiveSeasonId(env.DB);
  if (!seasonId) return json({ error: 'No active season is configured.' }, 500);

  const [league, season, settings, categories, lineupSlots, divisions, teams] = await Promise.all([
    first(env.DB, 'SELECT id, name FROM leagues LIMIT 1'),
    first(env.DB, 'SELECT id, year, label, slug FROM seasons WHERE id = ?', seasonId),
    first(env.DB, 'SELECT * FROM season_settings WHERE season_id = ?', seasonId),
    all(env.DB, 'SELECT code, display_order, category_type, lower_is_better FROM scoring_categories WHERE season_id = ? ORDER BY display_order', seasonId),
    all(env.DB, 'SELECT id, code, label, slot_type, eligible_positions, count, display_order FROM lineup_slots WHERE season_id = ? ORDER BY display_order', seasonId),
    all(env.DB, 'SELECT id, name, display_order FROM divisions WHERE season_id = ? ORDER BY display_order', seasonId),
    all(env.DB, 'SELECT id, name, division_id FROM teams WHERE season_id = ? ORDER BY name', seasonId),
  ]);

  return json({ league, season, settings, categories, lineupSlots, divisions, teams });
}
