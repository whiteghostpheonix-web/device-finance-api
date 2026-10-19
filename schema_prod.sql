-- Plan payment model: amount + period type + count
ALTER TABLE payment_plans ADD COLUMN amount_per_period REAL;
ALTER TABLE payment_plans ADD COLUMN period_type TEXT;
ALTER TABLE payment_plans ADD COLUMN period_count INTEGER;
ALTER TABLE payment_plans ADD COLUMN has_deposit INTEGER DEFAULT 0;
ALTER TABLE payment_plans ADD COLUMN deposit_amount REAL;
ALTER TABLE payment_plans ADD COLUMN deposit_due_days INTEGER DEFAULT 0;

-- Customer KYC extras
ALTER TABLE customers ADD COLUMN occupation TEXT;
ALTER TABLE customers ADD COLUMN monthly_income REAL;
ALTER TABLE customers ADD COLUMN nin_verified INTEGER DEFAULT 0;
ALTER TABLE customers ADD COLUMN kyc_status TEXT DEFAULT 'pending';

-- Guarantor extras
ALTER TABLE guarantors ADD COLUMN occupation TEXT;

-- Reseller KYC extras
ALTER TABLE resellers ADD COLUMN occupation TEXT;
ALTER TABLE resellers ADD COLUMN nin_verified INTEGER DEFAULT 0;

-- ID uniqueness: each NIN can only register one device
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_nin ON customers(nin) WHERE nin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_resellers_nin ON resellers(nin) WHERE nin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_guarantors_nin ON guarantors(nin) WHERE nin IS NOT NULL;
