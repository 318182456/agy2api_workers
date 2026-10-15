CREATE TABLE oauth_flows (
  state TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  mode TEXT NOT NULL,
  name TEXT NOT NULL,
  project_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_flows_expiry ON oauth_flows(expires_at);
