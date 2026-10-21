CREATE TABLE IF NOT EXISTS storage_nodes (
 id TEXT PRIMARY KEY,
 email TEXT NOT NULL,
 account_id TEXT NOT NULL UNIQUE,
 worker_name TEXT NOT NULL,
 node_secret TEXT NOT NULL,
 url TEXT,
 status TEXT NOT NULL DEFAULT 'provisioning',
 deployed INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 checked_at INTEGER
);
