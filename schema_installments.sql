CREATE TABLE IF NOT EXISTS plan_installments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER REFERENCES payment_plans(id) ON DELETE CASCADE,
  installment_number INTEGER NOT NULL,
  offset_days INTEGER NOT NULL,
  amount_ugx REAL NOT NULL,
  label TEXT,
  UNIQUE(plan_id, installment_number)
);
CREATE INDEX IF NOT EXISTS idx_plan_installments_plan ON plan_installments(plan_id);
