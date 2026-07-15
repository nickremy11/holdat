-- Commissioner-issued invites for a specific franchise. Distinct from
-- magic_link_tokens (which requires an existing users.id) -- an invite
-- exists precisely because the invitee doesn't have a user row yet.
-- Longer-lived than a login link (7 days, see INVITE_TTL_MS) since it sits
-- in someone's inbox before they act on it, not clicked within minutes.

CREATE TABLE franchise_invites (
  id INTEGER PRIMARY KEY,
  franchise_id INTEGER NOT NULL REFERENCES franchises(id),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id INTEGER REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_franchise_invites_franchise ON franchise_invites(franchise_id);
