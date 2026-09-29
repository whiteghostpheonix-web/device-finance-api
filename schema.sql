CREATE TABLE devices (
  imei TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  status TEXT DEFAULT 'active',
  fcm_token TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payment_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_name TEXT,
  total_amount_ugx REAL,
  installment_count INTEGER,
  grace_period_days INTEGER DEFAULT 3,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE schedules (
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

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER REFERENCES schedules(id),
  amount_ugx REAL,
  payment_method TEXT,
  reference TEXT,
  paid_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
