CREATE TABLE IF NOT EXISTS tenant_moveout_settlements (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 tenant_id INTEGER NOT NULL,
 property TEXT NOT NULL,
 tenant_name TEXT NOT NULL,
 phone TEXT NOT NULL,
 move_out_date TEXT NOT NULL,
 security_deposit REAL NOT NULL DEFAULT 0,
 pending_dues REAL NOT NULL DEFAULT 0,
 move_out_charge REAL NOT NULL DEFAULT 500,
 deposit_deductions REAL NOT NULL DEFAULT 0,
 refund_amount REAL NOT NULL DEFAULT 0,
 additional_due REAL NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tenant_moveout_settlement_tenant ON tenant_moveout_settlements(tenant_id, created_at DESC);
