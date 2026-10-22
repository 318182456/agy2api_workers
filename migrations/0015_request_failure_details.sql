ALTER TABLE request_usage ADD COLUMN failure_stage TEXT;
ALTER TABLE request_usage ADD COLUMN failure_code TEXT;
ALTER TABLE request_usage ADD COLUMN failure_message TEXT;
