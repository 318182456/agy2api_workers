ALTER TABLE request_usage ADD COLUMN attempts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE request_usage ADD COLUMN hidden_attempts TEXT NOT NULL DEFAULT '[]';
