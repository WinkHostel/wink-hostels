-- Retain tenant status and KYC status changes while the tenant record exists.
CREATE TABLE IF NOT EXISTS tenant_lifecycle_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  property TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tenant_lifecycle_history_tenant ON tenant_lifecycle_history(tenant_id, changed_at DESC);
CREATE TABLE IF NOT EXISTS tenant_kyc_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  property TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  kyc_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tenant_kyc_history_tenant ON tenant_kyc_history(tenant_id, recorded_at DESC);
