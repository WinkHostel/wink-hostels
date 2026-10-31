ALTER TABLE tenants ADD COLUMN move_out_date TEXT;
CREATE INDEX IF NOT EXISTS idx_tenants_move_out_date ON tenants(status, move_out_date);
