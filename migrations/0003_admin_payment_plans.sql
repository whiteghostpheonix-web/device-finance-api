-- Add the payment-plan fields used by the Signal Admin plan form and API.
-- Apply once to the production D1 database after schema.sql.
ALTER TABLE payment_plans ADD COLUMN frequency TEXT DEFAULT 'monthly';
ALTER TABLE payment_plans ADD COLUMN notes TEXT;
ALTER TABLE payment_plans ADD COLUMN amount_per_period REAL;
ALTER TABLE payment_plans ADD COLUMN period_type TEXT;
ALTER TABLE payment_plans ADD COLUMN period_count INTEGER;
ALTER TABLE payment_plans ADD COLUMN has_deposit INTEGER DEFAULT 0;
ALTER TABLE payment_plans ADD COLUMN deposit_amount REAL;
ALTER TABLE payment_plans ADD COLUMN deposit_due_days INTEGER DEFAULT 0;
