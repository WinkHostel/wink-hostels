-- Append-only audit records for charge corrections and payment refunds.
CREATE TABLE IF NOT EXISTS finance_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  tenant_phone TEXT NOT NULL,
  charge_id INTEGER,
  action TEXT NOT NULL CHECK (action IN ('charge_adjustment','refund')),
  amount REAL NOT NULL,
  old_amount REAL NOT NULL DEFAULT 0,
  new_amount REAL NOT NULL DEFAULT 0,
  old_paid_amount REAL NOT NULL DEFAULT 0,
  new_paid_amount REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finance_adjustments_tenant ON finance_adjustments(property, tenant_phone, created_at);
