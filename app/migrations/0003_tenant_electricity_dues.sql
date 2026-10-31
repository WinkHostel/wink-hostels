-- Tenant-linked electricity receivables. One row per resident/room/month.
CREATE TABLE IF NOT EXISTS tenant_electricity_dues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property TEXT NOT NULL,
  room TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  tenant_phone TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property, room, billing_period, tenant_name)
);
CREATE INDEX IF NOT EXISTS idx_tenant_electricity_dues_period ON tenant_electricity_dues(billing_period, property, status);
