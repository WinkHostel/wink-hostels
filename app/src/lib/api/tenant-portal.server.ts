import { bindings } from "../bindings.server";

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

export async function sessionTenantForPayments(token: string) {
  if (!token || token.length > 128) return null;
  const { DB } = bindings(); if (!DB) return null;
  const hash = await digest(token);
  const row = await DB.prepare("SELECT t.id,t.property,t.full_name,t.phone,t.room,t.monthly_rent,t.security_deposit,t.status,t.kyc_status,t.joined_on,t.rent_cycle,t.move_in_date,t.notice_period_days FROM tenant_portal_sessions s JOIN tenants t ON t.id=s.tenant_id JOIN tenant_portal_accounts a ON a.tenant_id=t.id AND a.must_change_pin=0 WHERE s.token_hash=? AND s.expires_at>datetime('now') AND t.status!='Vacated'").bind(hash).first<any>();
  return row ?? null;
}
