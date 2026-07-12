-- Schema only in Phase 1 -- the schedule generator, live-scoring poller, and
-- matchup-scoring computation are later phases. Created empty now so the
-- later phases don't require a schema redesign.

-- The integer id itself is the "matchup id per week" the
-- /[season-slug]/matchup/[id] route references -- no extra slug needed.
CREATE TABLE matchups (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  week INTEGER NOT NULL,
  team_a_id INTEGER NOT NULL REFERENCES teams(id),
  team_b_id INTEGER REFERENCES teams(id),
  start_date INTEGER NOT NULL,
  end_date INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('upcoming', 'live', 'final')),
  team_a_score TEXT,
  team_b_score TEXT,
  UNIQUE (season_id, week, team_a_id)
);

-- NBA schedule, needed to correlate live boxscore polls
-- (cdn.nba.com/static/json/liveData/boxscore/boxscore_{gameId}.json or the
-- ESPN hidden API as fallback -- see the live-stats plan discussion).
CREATE TABLE games (
  id INTEGER PRIMARY KEY,
  nba_game_id TEXT NOT NULL UNIQUE,
  game_date INTEGER NOT NULL,
  season_id INTEGER REFERENCES seasons(id),
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'live', 'final')),
  start_time INTEGER
);

CREATE INDEX idx_games_date ON games(game_date);

-- Raw box-score counts (fgm/fga, ftm/fta, ...), never precomputed FG%/FT% --
-- required for correct rate-stat aggregation, and the one thing that would be
-- genuinely painful to retrofit if skipped now. Powers both the future live
-- matchup tab and historical per-day/per-week/per-game stat lookups.
CREATE TABLE player_game_stats (
  id INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  nba_team TEXT NOT NULL,
  minutes REAL,
  pts INTEGER NOT NULL DEFAULT 0,
  reb INTEGER NOT NULL DEFAULT 0,
  ast INTEGER NOT NULL DEFAULT 0,
  stl INTEGER NOT NULL DEFAULT 0,
  blk INTEGER NOT NULL DEFAULT 0,
  tov INTEGER NOT NULL DEFAULT 0,
  fgm INTEGER NOT NULL DEFAULT 0,
  fga INTEGER NOT NULL DEFAULT 0,
  ftm INTEGER NOT NULL DEFAULT 0,
  fta INTEGER NOT NULL DEFAULT 0,
  tpm INTEGER NOT NULL DEFAULT 0,
  tpa INTEGER NOT NULL DEFAULT 0,
  plus_minus INTEGER,
  status TEXT NOT NULL CHECK (status IN ('live', 'final')),
  updated_at INTEGER NOT NULL,
  UNIQUE (game_id, player_id)
);

CREATE INDEX idx_player_game_stats_player ON player_game_stats(player_id);
CREATE INDEX idx_player_game_stats_game ON player_game_stats(game_id);
