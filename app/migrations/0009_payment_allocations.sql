-- Charge-level links for each newly recorded payment. Historical payments remain unallocated here until manually reviewed.
CREATE TABLE IF NOT EXISTS tenant_payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  charge_id INTEGER NOT NULL,
  allocated_amount REAL NOT NULL CHECK (allocated_amount > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(payment_id, charge_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment ON tenant_payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_charge ON tenant_payment_allocations(charge_id);
