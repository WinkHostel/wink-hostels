CREATE TABLE IF NOT EXISTS tenant_portal_accounts (
  tenant_id INTEGER PRIMARY KEY,
  property TEXT NOT NULL,
  phone TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tenant_portal_sessions (
  token_hash TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_expiry ON tenant_portal_sessions(expires_at);
CREATE TABLE IF NOT EXISTS tenant_moveout_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  property TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  requested_date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Requested' CHECK (status IN ('Requested','Approved','Declined','Completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_portal_moveout_tenant ON tenant_moveout_requests(tenant_id,created_at);
