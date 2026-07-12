-- Leagues, seasons, and per-season config. Replaces shared.js's LEAGUES array
-- (id + label pairs with implicit array-order "current" convention) with an
-- explicit table + status flag.

CREATE TABLE leagues (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL REFERENCES leagues(id),
  year INTEGER NOT NULL,
  label TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  fantrax_league_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('upcoming', 'active', 'complete')),
  start_date INTEGER,
  end_date INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_seasons_league ON seasons(league_id);

-- 1:1 with seasons. Nothing here is scraped from Fantrax -- all manual
-- commissioner input, since no confirmed Fantrax method exposes it.
CREATE TABLE season_settings (
  season_id INTEGER PRIMARY KEY REFERENCES seasons(id),
  roster_size INTEGER,
  bench_slots INTEGER,
  ir_slots INTEGER,
  keeper_rules TEXT,
  playoff_format TEXT,
  notes TEXT
);

-- Per-season scoring category config. Auto-detected from the roster-table
-- header the same way index.html/functions/api/fantrax.js's parseRoster()
-- already does; category_type/lower_is_better need a one-time manual map.
CREATE TABLE scoring_categories (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  code TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  category_type TEXT NOT NULL CHECK (category_type IN ('counting', 'rate')),
  lower_is_better INTEGER NOT NULL DEFAULT 0,
  UNIQUE (season_id, code)
);

-- Per-season roster-slot config (starter/bench/IR + eligible positions + count).
CREATE TABLE lineup_slots (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  slot_type TEXT NOT NULL CHECK (slot_type IN ('starter', 'bench', 'ir')),
  eligible_positions TEXT,
  count INTEGER NOT NULL,
  display_order INTEGER NOT NULL,
  UNIQUE (season_id, code)
);
