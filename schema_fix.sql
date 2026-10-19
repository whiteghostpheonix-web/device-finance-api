-- Ensure payment_plans has frequency + notes
ALTER TABLE payment_plans ADD COLUMN frequency TEXT DEFAULT 'monthly';
ALTER TABLE payment_plans ADD COLUMN notes TEXT;
