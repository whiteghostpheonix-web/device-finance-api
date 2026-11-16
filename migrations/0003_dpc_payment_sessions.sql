-- Short-lived payment sessions keep device identifiers and long-lived DPC credentials out of public checkout requests.
CREATE TABLE IF NOT EXISTS device_payment_sessions (
  token_hash TEXT PRIMARY KEY,
  device_imei TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_device_payment_sessions_expiry ON device_payment_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_device_payment_sessions_device ON device_payment_sessions(device_imei);
