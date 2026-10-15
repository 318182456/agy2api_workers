CREATE TABLE credential_cooldowns (
  credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  until_ms INTEGER NOT NULL,
  status INTEGER NOT NULL,
  PRIMARY KEY (credential_id, model)
);
CREATE INDEX cooldown_expiry ON credential_cooldowns(until_ms);
CREATE TABLE call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  credential_id TEXT,
  credential_name TEXT,
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  status INTEGER NOT NULL,
  stage TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  detail_code TEXT
);
CREATE INDEX call_logs_credential ON call_logs(credential_id, id DESC);
