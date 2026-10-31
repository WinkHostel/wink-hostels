-- Central tenant directory. Additive migration; existing local demo data is not deleted.
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  room TEXT NOT NULL DEFAULT '',
  monthly_rent REAL NOT NULL DEFAULT 0,
  security_deposit REAL NOT NULL DEFAULT 0,
  rent_cycle TEXT NOT NULL DEFAULT '1st of every month',
  status TEXT NOT NULL DEFAULT 'Occupied',
  kyc_status TEXT NOT NULL DEFAULT 'Pending',
  autopay INTEGER NOT NULL DEFAULT 0,
  joined_on TEXT NOT NULL DEFAULT (date('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property, phone)
);
CREATE INDEX IF NOT EXISTS idx_tenants_property_name ON tenants(property, full_name);
