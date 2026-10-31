-- Persistent room inventory shared by room allocation and electricity workflows.
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property TEXT NOT NULL,
  room TEXT NOT NULL,
  bed_capacity INTEGER NOT NULL DEFAULT 1 CHECK (bed_capacity BETWEEN 1 AND 20),
  floor TEXT NOT NULL DEFAULT 'Floor 1',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property, room)
);
CREATE INDEX IF NOT EXISTS idx_rooms_property_active ON rooms(property, active, room);
-- Keep existing meter-only rooms visible in inventory instead of losing them.
INSERT OR IGNORE INTO rooms (property, room, bed_capacity, active)
SELECT property, room, 1, active FROM room_meters;
