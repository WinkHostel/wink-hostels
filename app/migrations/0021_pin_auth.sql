ALTER TABLE tenant_portal_accounts ADD COLUMN must_change_pin INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tenant_portal_accounts ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenant_portal_accounts ADD COLUMN locked_until TEXT;
CREATE TABLE IF NOT EXISTS manager_pin_accounts (phone TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, pin_hash TEXT NOT NULL, must_change_pin INTEGER NOT NULL DEFAULT 1, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS manager_pin_sessions (token_hash TEXT PRIMARY KEY, phone TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
ALTER TABLE properties ADD COLUMN contact_phone TEXT NOT NULL DEFAULT '';
