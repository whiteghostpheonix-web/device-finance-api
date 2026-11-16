-- Multi-tenant foundation. Additive only: preserve all existing business and payment rows.
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tenant_branding (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  brand_name TEXT NOT NULL,
  logo_url TEXT,
  primary_color TEXT NOT NULL DEFAULT '#2563eb',
  support_phone TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Existing business records belong to the original Signal Electronics tenant.
INSERT OR IGNORE INTO organizations (id, name, slug, status)
VALUES ('org-signal-electronics', 'Signal Electronics', 'signal-electronics', 'active');
INSERT OR IGNORE INTO tenant_branding (org_id, brand_name, primary_color)
VALUES ('org-signal-electronics', 'Signal Electronics', '#2563eb');

ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'SUB_ADMIN'
  CHECK (role IN ('SUPER_ADMIN','ADMIN','SUB_ADMIN'));
ALTER TABLE admins ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE admins SET role = CASE WHEN id = 'primary-admin' THEN 'SUPER_ADMIN' ELSE 'ADMIN' END,
  org_id = CASE WHEN id = 'primary-admin' THEN NULL ELSE 'org-signal-electronics' END;

ALTER TABLE resellers ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE resellers SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE customer_applications ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE customer_applications SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE customers ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE customers SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

-- devices.org_id was added by migration 0002; backfill it without changing device data.
UPDATE devices SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE payment_plans ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE payment_plans SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE retailer_catalog_devices ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE retailer_catalog_devices SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE retailer_applications ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE retailer_applications SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE retailer_device_plan_rates ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE retailer_device_plan_rates SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE retailer_device_commissions ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE retailer_device_commissions SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE retailer_withdrawals ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE retailer_withdrawals SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE retailer_notifications ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE retailer_notifications SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE reseller_commission_settings ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE reseller_commission_settings SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE reseller_commissions ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE reseller_commissions SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE payment_orders ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE payment_orders SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

ALTER TABLE admin_audit_log ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE admin_audit_log SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_admins_org_role ON admins(org_id, role, active);
CREATE INDEX IF NOT EXISTS idx_resellers_org ON resellers(org_id, email);
CREATE INDEX IF NOT EXISTS idx_devices_org ON devices(org_id, imei);
CREATE INDEX IF NOT EXISTS idx_customers_org ON customers(org_id, id);
CREATE INDEX IF NOT EXISTS idx_customer_applications_org ON customer_applications(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_plans_org ON payment_plans(org_id, id);
CREATE INDEX IF NOT EXISTS idx_retailer_applications_org ON retailer_applications(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_retailer_commissions_org ON retailer_device_commissions(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_retailer_withdrawals_org ON retailer_withdrawals(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_org_device ON transactions(device_imei);

-- Child finance and operations records carry the tenant explicitly for safe filtering.
ALTER TABLE schedules ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE schedules SET org_id = (SELECT org_id FROM devices WHERE devices.imei = schedules.device_imei)
  WHERE org_id IS NULL;
ALTER TABLE transactions ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE transactions SET org_id = COALESCE(
  (SELECT org_id FROM devices WHERE devices.imei = transactions.device_imei),
  (SELECT d.org_id FROM schedules s JOIN devices d ON d.imei = s.device_imei WHERE s.id = transactions.schedule_id),
  'org-signal-electronics'
) WHERE org_id IS NULL;
ALTER TABLE commands ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE commands SET org_id = (SELECT org_id FROM devices WHERE devices.imei = commands.device_imei)
  WHERE org_id IS NULL;
ALTER TABLE guarantors ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE guarantors SET org_id = (SELECT org_id FROM customers WHERE customers.imei = guarantors.customer_imei)
  WHERE org_id IS NULL;
ALTER TABLE plan_installments ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE plan_installments SET org_id = (SELECT org_id FROM payment_plans WHERE payment_plans.id = plan_installments.plan_id)
  WHERE org_id IS NULL;
ALTER TABLE retailer_catalog_device_plans ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE retailer_catalog_device_plans SET org_id = (
  SELECT org_id FROM retailer_catalog_devices WHERE retailer_catalog_devices.id = retailer_catalog_device_plans.catalog_device_id
) WHERE org_id IS NULL;
ALTER TABLE payment_matches ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE payment_matches SET org_id = COALESCE(
  (SELECT org_id FROM devices WHERE devices.imei = payment_matches.device_imei), 'org-signal-electronics'
) WHERE org_id IS NULL;
ALTER TABLE device_commands ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE device_commands SET org_id = COALESCE(
  (SELECT org_id FROM devices WHERE devices.imei = device_commands.imei), 'org-signal-electronics'
) WHERE org_id IS NULL;
ALTER TABLE audit_log ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE audit_log SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;
ALTER TABLE admin_api_errors ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE admin_api_errors SET org_id = 'org-signal-electronics' WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_schedules_org_device ON schedules(org_id, device_imei);
CREATE INDEX IF NOT EXISTS idx_transactions_org ON transactions(org_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_commands_org_device ON commands(org_id, device_imei);
CREATE INDEX IF NOT EXISTS idx_guarantors_org_customer ON guarantors(org_id, customer_imei);
CREATE INDEX IF NOT EXISTS idx_catalog_device_plans_org ON retailer_catalog_device_plans(org_id, catalog_device_id, plan_id);
