ALTER TABLE request_usage ADD COLUMN aggregate_key TEXT;
CREATE TABLE usage_aggregates (
 bucket_key TEXT PRIMARY KEY,
 version INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 credential_id TEXT,
 payload TEXT NOT NULL,
 members TEXT NOT NULL
);
CREATE INDEX usage_aggregates_time ON usage_aggregates(created_at);
CREATE INDEX usage_aggregates_credential ON usage_aggregates(credential_id,created_at);

CREATE INDEX request_usage_aggregate ON request_usage(aggregate_key) WHERE aggregate_key IS NOT NULL;
CREATE INDEX request_usage_packed_time ON request_usage(created_at) WHERE attempts<>'[]';
