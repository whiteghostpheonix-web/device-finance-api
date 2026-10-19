ALTER TABLE devices ADD COLUMN reseller_email TEXT;
ALTER TABLE payment_plans ADD COLUMN frequency TEXT DEFAULT 'monthly';
ALTER TABLE payment_plans ADD COLUMN notes TEXT;
