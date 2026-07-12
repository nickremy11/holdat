-- Franchise vs. team split: franchises persist across seasons (the actual
-- owner identity); teams are season-scoped rows, since Fantrax renders
-- historical trades/rosters with each team's contemporaneous name/logo, not
-- today's. franchises.owner_user_id references users(id), created in
-- migration 0003 -- SQLite resolves FK targets lazily, so declaration order
-- across files is fine.

CREATE TABLE franchises (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  logo_url TEXT,
  owner_user_id INTEGER UNIQUE REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  franchise_id INTEGER NOT NULL REFERENCES franchises(id),
  name TEXT NOT NULL,
  short_name TEXT,
  slug TEXT NOT NULL,
  logo_url TEXT,
  fantrax_team_id TEXT,
  draft_slot INTEGER,
  UNIQUE (season_id, franchise_id),
  UNIQUE (season_id, fantrax_team_id),
  UNIQUE (season_id, slug)
);

CREATE INDEX idx_teams_season ON teams(season_id);

-- Frozen snapshot of getStandings at import time -- otherwise unrecoverable
-- once Fantrax access lapses. Not a live standings-computation engine.
CREATE TABLE season_standings (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL UNIQUE REFERENCES teams(id),
  rank INTEGER,
  wins INTEGER,
  losses INTEGER,
  ties INTEGER,
  win_pct TEXT,
  pts_for REAL,
  pts_against REAL
);
