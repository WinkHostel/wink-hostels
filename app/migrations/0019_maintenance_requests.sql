CREATE TABLE IF NOT EXISTS maintenance_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property TEXT NOT NULL,
  room TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  tenant_phone TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Low','Normal','High','Urgent')),
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','In Progress','Waiting for Parts','Resolved','Closed')),
  assigned_to TEXT NOT NULL DEFAULT '',
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_maintenance_property_status ON maintenance_requests(property,status,created_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_tenant ON maintenance_requests(property,tenant_phone,created_at);
