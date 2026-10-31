-- Unified receivables ledger for rent and electricity, plus a durable payment audit trail.
CREATE TABLE IF NOT EXISTS tenant_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  tenant_phone TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '',
  billing_period TEXT NOT NULL,
  charge_type TEXT NOT NULL CHECK (charge_type IN ('rent','electricity')),
  description TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property, tenant_phone, billing_period, charge_type, room)
);
CREATE INDEX IF NOT EXISTS idx_tenant_charges_due ON tenant_charges(property, tenant_phone, status, billing_period);
CREATE TABLE IF NOT EXISTS tenant_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  tenant_phone TEXT NOT NULL,
  amount REAL NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'Cash',
  reference TEXT NOT NULL DEFAULT '',
  allocated_amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tenant_payments_tenant ON tenant_payments(property, tenant_phone, created_at);
