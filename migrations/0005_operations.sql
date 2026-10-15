ALTER TABLE credentials ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credentials ADD COLUMN weight INTEGER NOT NULL DEFAULT 1;
CREATE TABLE credential_health (
  credential_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  last_success INTEGER,
  last_failure INTEGER,
  last_status INTEGER,
  last_stage TEXT,
  last_code TEXT,
  failure_streak INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE request_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  credential_id TEXT,
  credential_name TEXT,
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  status INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  thought_tokens INTEGER,
  total_tokens INTEGER
);
CREATE INDEX request_usage_time ON request_usage(created_at);
CREATE INDEX request_usage_credential ON request_usage(credential_id, created_at);
CREATE INDEX call_logs_time ON call_logs(created_at);
