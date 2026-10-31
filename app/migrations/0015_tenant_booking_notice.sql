ALTER TABLE tenants ADD COLUMN move_in_date TEXT;
ALTER TABLE tenants ADD COLUMN notice_period_days INTEGER NOT NULL DEFAULT 30;
CREATE INDEX IF NOT EXISTS idx_tenants_move_in_date ON tenants(status, move_in_date);
