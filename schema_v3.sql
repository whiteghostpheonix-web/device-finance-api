ALTER TABLE devices ADD COLUMN reseller_email TEXT;
CREATE INDEX IF NOT EXISTS idx_devices_reseller ON devices(reseller_email);
