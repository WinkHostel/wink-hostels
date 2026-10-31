CREATE TABLE IF NOT EXISTS tenant_profile_photos (
  tenant_id INTEGER PRIMARY KEY,
  property TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Fold the retired Eviction label into the simpler notice workflow.
UPDATE tenants SET status='Under Notice', updated_at=datetime('now') WHERE status='Eviction';
