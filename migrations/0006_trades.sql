-- A trade groups multiple legs; each leg moves one asset (player or draft
-- pick) from one team to another. Exactly one of player_id/draft_pick_asset_id
-- is set, matching asset_type.

CREATE TABLE trades (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  fantrax_tx_set_id TEXT UNIQUE,
  traded_at INTEGER NOT NULL,
  week INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_trades_season ON trades(season_id);

CREATE TABLE trade_legs (
  id INTEGER PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES trades(id),
  from_team_id INTEGER NOT NULL REFERENCES teams(id),
  to_team_id INTEGER NOT NULL REFERENCES teams(id),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('player', 'pick')),
  player_id INTEGER REFERENCES players(id),
  draft_pick_asset_id INTEGER REFERENCES draft_pick_assets(id),
  CHECK (
    (asset_type = 'player' AND player_id IS NOT NULL AND draft_pick_asset_id IS NULL) OR
    (asset_type = 'pick' AND draft_pick_asset_id IS NOT NULL AND player_id IS NULL)
  )
);

CREATE INDEX idx_trade_legs_trade ON trade_legs(trade_id);
CREATE INDEX idx_trade_legs_player ON trade_legs(player_id);
CREATE INDEX idx_trade_legs_pick_asset ON trade_legs(draft_pick_asset_id);

-- Natural key for idempotent re-import: the same asset moving between the same
-- two teams within one trade should only ever produce one row.
CREATE UNIQUE INDEX idx_trade_legs_natural_key
  ON trade_legs(trade_id, from_team_id, to_team_id, asset_type, player_id, draft_pick_asset_id);
