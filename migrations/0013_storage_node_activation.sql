ALTER TABLE storage_nodes ADD COLUMN activated_at INTEGER;
UPDATE storage_nodes SET activated_at=created_at WHERE status='ready';
