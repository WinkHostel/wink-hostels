CREATE TABLE IF NOT EXISTS property_onboarding_configs (
  property TEXT PRIMARY KEY,
  mandatory_fields_json TEXT NOT NULL DEFAULT '["permanent_address","emergency_contact_name","emergency_contact_phone","profile_photo","aadhaar"]',
  mandatory_documents_json TEXT NOT NULL DEFAULT '["aadhaar"]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_onboarding_profiles (
  tenant_id INTEGER PRIMARY KEY,
  property TEXT NOT NULL,
  blood_group TEXT NOT NULL DEFAULT '',
  guardian_name TEXT NOT NULL DEFAULT '',
  guardian_phone TEXT NOT NULL DEFAULT '',
  occupation TEXT NOT NULL DEFAULT '',
  permanent_address TEXT NOT NULL DEFAULT '',
  emergency_contact_name TEXT NOT NULL DEFAULT '',
  emergency_contact_phone TEXT NOT NULL DEFAULT '',
  submitted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

ALTER TABLE tenant_kyc_documents ADD COLUMN document_type TEXT NOT NULL DEFAULT 'aadhaar';
ALTER TABLE tenant_kyc_documents ADD COLUMN review_status TEXT NOT NULL DEFAULT 'Pending';
ALTER TABLE tenant_kyc_documents ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
ALTER TABLE tenant_kyc_documents ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE tenant_kyc_documents ADD COLUMN reviewed_at TEXT;
ALTER TABLE tenant_kyc_documents ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_tenant_kyc_current ON tenant_kyc_documents(tenant_id, document_type, is_current);
UPDATE tenant_kyc_documents SET document_type='aadhaar', review_status='Pending' WHERE document_type='aadhaar';

INSERT INTO tenant_kyc_documents(tenant_id,property,tenant_name,document_name,content_type,object_key,file_size,uploaded_by,document_type,review_status,is_current) SELECT p.tenant_id,p.property,t.full_name,'Profile photo','image/jpeg',p.object_key,p.file_size,'Existing upload','profile_photo','Pending',1 FROM tenant_profile_photos p JOIN tenants t ON t.id=p.tenant_id WHERE NOT EXISTS (SELECT 1 FROM tenant_kyc_documents d WHERE d.tenant_id=p.tenant_id AND d.document_type='profile_photo' AND d.is_current=1);

UPDATE manager_pin_accounts SET must_change_pin=1,failed_attempts=0,locked_until=NULL WHERE phone='7200352252';
UPDATE tenant_portal_accounts SET must_change_pin=1,failed_attempts=0,locked_until=NULL;
UPDATE tenants SET kyc_status='Pending',updated_at=datetime('now') WHERE kyc_status='Verified';
