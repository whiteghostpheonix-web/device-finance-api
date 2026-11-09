-- Additive, safe-to-repeat tables for admin review and reseller commissions.
-- Existing customer, reseller, transaction and audit data is not modified.

CREATE TABLE IF NOT EXISTS admin_customer_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason TEXT,
  reviewed_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_customer_reviews_customer
  ON admin_customer_reviews(customer_id, created_at);

CREATE TABLE IF NOT EXISTS reseller_commission_settings (
  reseller_id TEXT PRIMARY KEY,
  rate_percent REAL NOT NULL DEFAULT 0 CHECK (rate_percent >= 0 AND rate_percent <= 100),
  fixed_amount_ugx REAL NOT NULL DEFAULT 0 CHECK (fixed_amount_ugx >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reseller_commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE,
  gross_amount_ugx REAL NOT NULL CHECK (gross_amount_ugx >= 0),
  commission_amount_ugx REAL NOT NULL CHECK (commission_amount_ugx >= 0),
  rate_percent REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','void')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reseller_commissions_reseller
  ON reseller_commissions(reseller_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reseller_commissions_status
  ON reseller_commissions(status);
