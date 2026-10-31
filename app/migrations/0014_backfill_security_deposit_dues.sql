INSERT OR IGNORE INTO tenant_charges (property, tenant_name, tenant_phone, room, billing_period, charge_type, description, amount, paid_amount, status, due_date, invoice_number, updated_at)
SELECT property, full_name, phone, room,
       substr(COALESCE(move_in_date, joined_on, date('now')),1,7) || '-DEPOSIT',
       'rent', 'Security deposit', security_deposit, 0, 'unpaid',
       COALESCE(move_in_date, joined_on, date('now')),
       'WH-DEP-' || replace(substr(COALESCE(move_in_date, joined_on, date('now')),1,7),'-','') || '-' || substr(replace(phone,' ',''),-4),
       datetime('now')
FROM tenants
WHERE COALESCE(security_deposit,0) > 0;
