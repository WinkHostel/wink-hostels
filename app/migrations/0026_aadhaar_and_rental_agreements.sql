ALTER TABLE tenant_onboarding_profiles ADD COLUMN aadhaar_ciphertext TEXT NOT NULL DEFAULT '';
ALTER TABLE tenant_onboarding_profiles ADD COLUMN aadhaar_last4 TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS rental_agreement_templates (
  property TEXT PRIMARY KEY,
  template_text TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tenant_rental_agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  property TEXT NOT NULL,
  agreement_html TEXT NOT NULL,
  signature_data_url TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tenant_rental_agreements_tenant ON tenant_rental_agreements(tenant_id, id DESC);
