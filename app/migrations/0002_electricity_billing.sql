-- Persistent month-by-month room sub-meter calculations and occupant splits.
CREATE TABLE IF NOT EXISTS electricity_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property TEXT NOT NULL,
  room TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  initial_reading REAL NOT NULL DEFAULT 0,
  final_reading REAL NOT NULL DEFAULT 0,
  rate_per_unit REAL NOT NULL DEFAULT 11,
  units_used REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  members_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property, room, billing_period)
);
CREATE INDEX IF NOT EXISTS idx_electricity_bills_period ON electricity_bills(billing_period, property);
