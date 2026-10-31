-- Invoice metadata and due dates for aging/overdue tracking.
ALTER TABLE tenant_charges ADD COLUMN due_date TEXT NOT NULL DEFAULT '';
ALTER TABLE tenant_charges ADD COLUMN invoice_number TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_tenant_charges_due_date ON tenant_charges(property,due_date,status);
