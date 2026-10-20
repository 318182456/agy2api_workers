CREATE INDEX usage_aggregates_api_key_time ON usage_aggregates(api_key_id,created_at);
CREATE INDEX usage_aggregates_last_success ON usage_aggregates(credential_id,json_extract(payload,'$.last_success') DESC) WHERE json_extract(payload,'$.last_success') IS NOT NULL;
CREATE INDEX request_usage_success_time ON request_usage(credential_id,created_at DESC) WHERE outcome='success';
