CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('geminicli', 'antigravity')),
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(mode, name)
);
CREATE INDEX credentials_rotation ON credentials(mode, disabled, last_used);
