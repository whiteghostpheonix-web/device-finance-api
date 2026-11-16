-- Additive DPC/payment support. Existing devices, schedules and transactions are preserved.
ALTER TABLE devices ADD COLUMN dpc_token_hash TEXT;
ALTER TABLE devices ADD COLUMN enrollment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE devices ADD COLUMN last_seen_at TEXT;
ALTER TABLE devices ADD COLUMN manufacturer TEXT;
ALTER TABLE devices ADD COLUMN model TEXT;
ALTER TABLE devices ADD COLUMN android_sdk INTEGER;
ALTER TABLE devices ADD COLUMN dpc_version TEXT;
ALTER TABLE devices ADD COLUMN allowed_apps TEXT NOT NULL DEFAULT '["com.whatsapp","com.whatsapp.w4b","com.android.dialer","com.google.android.dialer","com.android.phone","com.android.contacts"]';
ALTER TABLE devices ADD COLUMN security_config TEXT NOT NULL DEFAULT '{"knox":{"enabled":false,"configured":false},"transsion":{"enabled":false,"configured":false}}';
ALTER TABLE devices ADD COLUMN org_id TEXT;

ALTER TABLE transactions ADD COLUMN device_imei TEXT;
ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE transactions ADD COLUMN provider TEXT;
ALTER TABLE transactions ADD COLUMN provider_tx_id TEXT;
ALTER TABLE transactions ADD COLUMN provider_payload TEXT;
ALTER TABLE transactions ADD COLUMN fee_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN net_amount REAL;
ALTER TABLE transactions ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_dpc_token_hash ON devices(dpc_token_hash);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
CREATE INDEX IF NOT EXISTS idx_transactions_device_imei ON transactions(device_imei);
