-- Persistent room sub-meter registry. Monthly readings remain in electricity_bills.
CREATE TABLE IF NOT EXISTS room_meters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property TEXT NOT NULL,
  room TEXT NOT NULL,
  meter_number TEXT NOT NULL DEFAULT '',
  default_rate REAL NOT NULL DEFAULT 11 CHECK (default_rate >= 0),
  member_names TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property, room)
);
CREATE INDEX IF NOT EXISTS idx_room_meters_property_active ON room_meters(property, active, room);

-- Backfill the registry from any room/month bills already recorded before this migration.
INSERT OR IGNORE INTO room_meters (property, room, meter_number, default_rate, member_names, active, updated_at)
SELECT b.property, b.room, '', b.rate_per_unit,
       COALESCE((SELECT group_concat(json_extract(j.value, '$.name'), ', ')
                 FROM json_each(b.members_json) AS j), ''),
       1, datetime('now')
FROM electricity_bills b
WHERE b.billing_period = (
  SELECT MAX(b2.billing_period) FROM electricity_bills b2
  WHERE b2.property = b.property AND b2.room = b.room
);
