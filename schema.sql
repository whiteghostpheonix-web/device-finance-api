CREATE TABLE IF NOT EXISTS devices (
  imei TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  status TEXT DEFAULT 'active',
  fcm_token TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_name TEXT,
  total_amount_ugx REAL,
  installment_count INTEGER,
  grace_period_days INTEGER DEFAULT 3,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_imei TEXT REFERENCES devices(imei),
  plan_id INTEGER REFERENCES payment_plans(id),
  installment_number INTEGER,
  due_date DATE,
  amount_due_ugx REAL,
  amount_paid_ugx REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',
  UNIQUE(device_imei, installment_number)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER REFERENCES schedules(id),
  amount_ugx REAL,
  payment_method TEXT,
  reference TEXT,
  paid_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_imei TEXT REFERENCES devices(imei),
  command TEXT NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'queued',
  payload TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME,
  acknowledged_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status);
CREATE INDEX IF NOT EXISTS idx_commands_device ON commands(device_imei);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT,
  entity_id TEXT,
  action TEXT,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
