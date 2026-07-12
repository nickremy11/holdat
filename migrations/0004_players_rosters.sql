-- Players are a league-agnostic universe (rostered + free agents), not scoped
-- to a single holdat roster -- see functions/api/admin/import-player-universe.js,
-- which fills in NBA/two-way players never rostered in this league.
-- position_eligibility stays a raw comma list (e.g. "PG,SG,G"); the G/G-F/F/F-C/C
-- display buckets used by index.html are computed client-side at render time,
-- never persisted, matching current behavior.

CREATE TABLE players (
  id INTEGER PRIMARY KEY,
  fantrax_scorer_id TEXT UNIQUE,
  full_name TEXT NOT NULL,
  short_name TEXT,
  nba_team TEXT,
  nba_team_name TEXT,
  headshot_url TEXT,
  position_eligibility TEXT,
  is_two_way INTEGER,
  birth_date INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Decouples player identity from any one source so the future live-stats
-- poller (NBA.com/ESPN ids) and the balldontlie player-universe sync have
-- somewhere to record their ids without touching the players table itself.
CREATE TABLE player_external_ids (
  id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id),
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  UNIQUE (source, external_id)
);

CREATE INDEX idx_player_external_ids_player ON player_external_ids(player_id);

-- Current roster membership (team <-> player <-> season). This app owns
-- rosters going forward, so this is live state, not a point-in-time snapshot;
-- a full transaction/lineup-change history table is a later-phase addition.
CREATE TABLE roster_entries (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  slot_id INTEGER REFERENCES lineup_slots(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'reserve', 'ir')),
  fantrax_status_id TEXT,
  is_rookie_season INTEGER NOT NULL DEFAULT 0,
  acquired_at INTEGER,
  acquired_via TEXT CHECK (acquired_via IN ('import', 'draft', 'trade', 'free_agent', 'waiver')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (team_id, player_id)
);

CREATE INDEX idx_roster_entries_team ON roster_entries(team_id);
CREATE INDEX idx_roster_entries_player ON roster_entries(player_id);
