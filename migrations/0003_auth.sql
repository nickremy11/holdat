-- Magic-link auth: users seeded once by the commissioner (one row per owner),
-- short-lived magic_link_tokens exchanged for long-lived sessions. Raw tokens
-- are never stored, only their SHA-256 hash.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  is_commissioner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE magic_link_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  requested_ip TEXT
);

CREATE INDEX idx_magic_link_tokens_user ON magic_link_tokens(user_id);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  user_agent TEXT
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
