ALTER TABLE payment_plans ADD COLUMN frequency TEXT DEFAULT 'monthly';
ALTER TABLE payment_plans ADD COLUMN notes TEXT;
