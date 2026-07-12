-- Draft pick ownership needs two tables. draft_pick_assets is a
-- franchise-scoped ownership ledger that works even before a season/draft
-- exists (handles trades for e.g. "2028 2nd, via original owner"). draft_picks
-- is the resolved draft-day event (round/slot/player). They link once that
-- draft actually runs. This mirrors the two cases functions/api/fantrax.js's
-- resolveDraftedPicks() already handles: slot-known-at-trade-time vs.
-- original-owner-name-only.

CREATE TABLE draft_classes (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL UNIQUE REFERENCES seasons(id),
  draft_type TEXT NOT NULL DEFAULT 'rookie',
  rounds INTEGER NOT NULL,
  slots_per_round INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'in_progress', 'complete')),
  completed_at INTEGER
);

-- Original slot-holder per draft class -- this is what "original owner"
-- resolution needs (fantasyTeamsOrdered in getDraftResults).
CREATE TABLE draft_order (
  id INTEGER PRIMARY KEY,
  draft_class_id INTEGER NOT NULL REFERENCES draft_classes(id),
  slot INTEGER NOT NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  UNIQUE (draft_class_id, slot)
);

CREATE TABLE draft_picks (
  id INTEGER PRIMARY KEY,
  draft_class_id INTEGER NOT NULL REFERENCES draft_classes(id),
  round INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  overall_pick INTEGER NOT NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  player_id INTEGER REFERENCES players(id),
  drafted_at INTEGER,
  UNIQUE (draft_class_id, round, slot)
);

CREATE INDEX idx_draft_picks_class ON draft_picks(draft_class_id);

-- Franchise-scoped ownership ledger. A trade leg moving a pick updates
-- current_franchise_id here; draft_pick_id links once that year's draft runs.
CREATE TABLE draft_pick_assets (
  id INTEGER PRIMARY KEY,
  draft_year INTEGER NOT NULL,
  round INTEGER NOT NULL,
  original_franchise_id INTEGER NOT NULL REFERENCES franchises(id),
  current_franchise_id INTEGER NOT NULL REFERENCES franchises(id),
  draft_pick_id INTEGER REFERENCES draft_picks(id),
  created_at INTEGER NOT NULL,
  UNIQUE (draft_year, round, original_franchise_id)
);

CREATE INDEX idx_draft_pick_assets_current_franchise ON draft_pick_assets(current_franchise_id);
