-- Additive Signal Electronics admin workflow schema.
-- Safe to re-apply: all objects use IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS customer_applications (
  id TEXT PRIMARY KEY,
  reseller_id TEXT,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  nin TEXT,
  occupation TEXT,
  monthly_income_ugx INTEGER,
  guarantor_json TEXT,
  device_json TEXT,
  finance_plan_json TEXT,
  kyc_media_json TEXT,
  deposit_amount_ugx INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  decision_reason TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customer_applications_status_created
  ON customer_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_applications_reseller
  ON customer_applications(reseller_id);

CREATE TABLE IF NOT EXISTS reseller_commission_settings (
  reseller_id TEXT PRIMARY KEY,
  rate_percent REAL NOT NULL DEFAULT 0 CHECK (rate_percent >= 0 AND rate_percent <= 100),
  fixed_amount_ugx INTEGER NOT NULL DEFAULT 0 CHECK (fixed_amount_ugx >= 0),
  applies_to TEXT NOT NULL DEFAULT 'received_payment'
    CHECK (applies_to IN ('received_payment','device_sale')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reseller_commissions (
  id TEXT PRIMARY KEY,
  reseller_id TEXT NOT NULL,
  customer_application_id TEXT,
  payment_reference TEXT NOT NULL UNIQUE,
  payment_amount_ugx INTEGER NOT NULL CHECK (payment_amount_ugx > 0),
  rate_percent REAL NOT NULL,
  fixed_amount_ugx INTEGER NOT NULL DEFAULT 0,
  commission_amount_ugx INTEGER NOT NULL CHECK (commission_amount_ugx >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','paid','void')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reseller_commissions_reseller_status
  ON reseller_commissions(reseller_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created
  ON admin_audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS admin_api_errors (
  id TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  error_code TEXT NOT NULL,
  message TEXT NOT NULL,
  admin_email TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_api_errors_created
  ON admin_api_errors(created_at DESC);
