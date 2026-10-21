CREATE TABLE telemetry_revision(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
INSERT INTO telemetry_revision(id,value)VALUES(1,0);
ALTER TABLE usage_aggregates ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX usage_aggregates_changes ON usage_aggregates(change_seq,bucket_key);
CREATE TABLE usage_daily_archive(archive_key TEXT PRIMARY KEY,day INTEGER NOT NULL,change_seq INTEGER NOT NULL,payload BLOB NOT NULL,detail_ids TEXT NOT NULL);
CREATE INDEX usage_daily_archive_changes ON usage_daily_archive(change_seq,archive_key);
CREATE INDEX usage_daily_archive_day ON usage_daily_archive(day);
