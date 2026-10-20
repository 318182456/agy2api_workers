CREATE TABLE api_keys (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 key_hash TEXT NOT NULL UNIQUE,
 masked_key TEXT NOT NULL,
 key_value TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 expires_at INTEGER,
 created_at INTEGER NOT NULL
);
ALTER TABLE request_usage ADD COLUMN api_key_id TEXT;
ALTER TABLE request_usage ADD COLUMN api_key_name TEXT;
CREATE INDEX request_usage_api_key ON request_usage(api_key_id,created_at);
ALTER TABLE usage_aggregates ADD COLUMN api_key_id TEXT;
