CREATE TABLE IF NOT EXISTS tenant_upi_payment_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  tenant_name TEXT NOT NULL,
  tenant_phone TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  upi_reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
  admin_note TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upi_payment_reference ON tenant_upi_payment_requests(property, tenant_phone, upi_reference);
CREATE INDEX IF NOT EXISTS idx_upi_payment_status ON tenant_upi_payment_requests(property, status, submitted_at);

ALTER TABLE tenant_payments ADD COLUMN upi_request_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_payments_upi_request ON tenant_payments(upi_request_id);
