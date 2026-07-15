-- Expands season_settings to cover the full commissioner Settings page
-- (scoring system, taxi/roster/illegal-roster toggles, waivers, draft,
-- schedule/playoff parameters -- see league_rules_spec memory for the full
-- source spec). Kept as one flat table, matching its existing
-- single-per-season-blob shape, rather than splitting into per-topic
-- 1:1 tables.

ALTER TABLE season_settings ADD COLUMN scoring_type TEXT CHECK (scoring_type IN ('rotisserie', 'h2h_points', 'h2h_categories'));
ALTER TABLE season_settings ADD COLUMN taxi_slots INTEGER;
ALTER TABLE season_settings ADD COLUMN allow_illegal_result INTEGER NOT NULL DEFAULT 0;
ALTER TABLE season_settings ADD COLUMN allow_lineup_changes_while_illegal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE season_settings ADD COLUMN allow_player_adds_while_illegal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE season_settings ADD COLUMN waiver_days INTEGER;
ALTER TABLE season_settings ADD COLUMN waiver_max_claims_per_week INTEGER;
ALTER TABLE season_settings ADD COLUMN waiver_move_to_back INTEGER NOT NULL DEFAULT 1;
ALTER TABLE season_settings ADD COLUMN draft_next_at INTEGER;
ALTER TABLE season_settings ADD COLUMN draft_rounds INTEGER;
ALTER TABLE season_settings ADD COLUMN draft_pick_time_limit_hours INTEGER;
ALTER TABLE season_settings ADD COLUMN draft_timeout_behavior TEXT CHECK (draft_timeout_behavior IN ('auto_pick', 'pause'));
ALTER TABLE season_settings ADD COLUMN draft_undrafted_becomes TEXT CHECK (draft_undrafted_becomes IN ('free_agent', 'waivers'));
ALTER TABLE season_settings ADD COLUMN season_start_date INTEGER;
ALTER TABLE season_settings ADD COLUMN regular_season_weeks INTEGER;
ALTER TABLE season_settings ADD COLUMN playoff_weeks INTEGER;
ALTER TABLE season_settings ADD COLUMN playoff_byes INTEGER;
ALTER TABLE season_settings ADD COLUMN playoff_bye_criteria TEXT CHECK (playoff_bye_criteria IN ('top2_overall', 'division_winners', 'manual'));
ALTER TABLE season_settings ADD COLUMN playoff_first_round_structure TEXT CHECK (playoff_first_round_structure IN ('division_2v3', 'non_division_winner_vs_6_and_4v5'));

-- Zero rows anywhere as of this migration (roster/lineup editing was never
-- built) -- recreated instead of SQLite's multi-step ALTER-CHECK dance.
DROP TABLE lineup_slots;
CREATE TABLE lineup_slots (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  slot_type TEXT NOT NULL CHECK (slot_type IN ('starter', 'bench', 'ir', 'taxi')),
  eligible_positions TEXT,
  count INTEGER NOT NULL,
  display_order INTEGER NOT NULL,
  UNIQUE (season_id, code)
);

CREATE TABLE divisions (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  UNIQUE (season_id, name)
);

ALTER TABLE teams ADD COLUMN division_id INTEGER REFERENCES divisions(id);
