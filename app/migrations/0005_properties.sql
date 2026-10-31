-- Persistent property/branch directory.
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO properties (name, address) VALUES
 ('Wink Hostel - Perungudi', 'Perungudi, Chennai'),
 ('Kurinji Nagar', 'Chennai, Tamil Nadu'),
 ('1st Street', 'Chennai, Tamil Nadu'),
 ('2nd Street', 'Chennai, Tamil Nadu');
