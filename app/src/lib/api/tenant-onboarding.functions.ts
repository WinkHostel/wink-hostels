import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";
import { sessionTenantForPayments } from "./tenant-portal.server";

const tokenSchema = z.string().min(20).max(128);
const fields = ["permanent_address", "emergency_contact_name", "emergency_contact_phone", "blood_group", "guardian_name", "guardian_phone", "occupation", "profile_photo", "aadhaar", "company_college_id"] as const;
const documents = ["aadhaar", "company_college_id", "profile_photo", "other"] as const;
const defaults = { mandatoryFields: ["permanent_address", "emergency_contact_name", "emergency_contact_phone", "profile_photo", "aadhaar"], mandatoryDocuments: ["aadhaar"] };
async function digest(token: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), "PBKDF2", false, ["deriveBits"]);
  const bytes = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode("wink-session-v1"), iterations: 100000, hash: "SHA-256" }, key, 256);
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
async function manager(DB: any, token: string) {
  const hash = await digest(token);
  return DB.prepare("SELECT a.phone,a.name,a.role FROM manager_pin_sessions s JOIN manager_pin_accounts a ON a.phone=s.phone WHERE s.token_hash=? AND s.expires_at>datetime('now') AND a.must_change_pin=0").bind(hash).first() as { phone: string; name: string; role: string } | null;
}
const realId = (id: number) => id >= 100000 ? id - 100000 : id;
async function configFor(DB: any, property: string) {
  const row = await DB.prepare("SELECT mandatory_fields_json,mandatory_documents_json FROM property_onboarding_configs WHERE property=?").bind(property).first() as any;
  try {
    return {
      mandatoryFields: row ? JSON.parse(row.mandatory_fields_json) as string[] : defaults.mandatoryFields,
      mandatoryDocuments: row ? JSON.parse(row.mandatory_documents_json) as string[] : defaults.mandatoryDocuments,
    };
  } catch { return defaults; }
}
const optionalPhone = z.string().trim().max(20).default("").refine(value => !value || /^[+0-9()\s-]{10,20}$/.test(value) && value.replace(/\D/g, "").length >= 10 && value.replace(/\D/g, "").length <= 15, "Enter a valid contact number.");
const profileSchema = z.object({
  aadhaarNumber: z.string().trim().default("").refine(v => !v || /^\d{12}$/.test(v), "Enter a valid 12-digit Aadhaar number."),
  bloodGroup: z.string().trim().max(8).default(""), guardianName: z.string().trim().max(120).default(""),
  guardianPhone: optionalPhone, occupation: z.string().trim().max(120).default(""),
  permanentAddress: z.string().trim().max(1000).default(""), emergencyContactName: z.string().trim().max(120).default(""),
  emergencyContactPhone: optionalPhone,
});
async function encryptAadhaar(value:string){const secret=bindings().AADHAAR_ENCRYPTION_KEY;if(!secret)throw new Error("Aadhaar encryption is not configured. Please contact the administrator.");const keyBytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(secret));const key=await crypto.subtle.importKey("raw",keyBytes,{name:"AES-GCM"},false,["encrypt"]);const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(value));const b64=(b:Uint8Array)=>btoa(String.fromCharCode(...b));return `v1.${b64(iv)}.${b64(new Uint8Array(cipher))}`;}
function maskAadhaar(ciphertext:string){return ciphertext?"XXXX XXXX XXXX":"";}

export const getPropertyOnboardingConfig = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, property: z.string().trim().min(1).max(180) })).handler(async ({ data }) => {
  const { DB } = bindings(); if (!DB) return { ok: false as const, message: "Database unavailable." };
  const user = await manager(DB, data.token); if (!user) return { ok: false as const, message: "Please sign in again." };
  const config = await configFor(DB, data.property);
  const p = await DB.prepare("SELECT contact_phone FROM properties WHERE name=?").bind(data.property).first<any>();
  return { ok: true as const, ...config, contactPhone: p?.contact_phone || "7200352252" };
});

export const savePropertyOnboardingConfig = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, property: z.string().trim().min(1).max(180), mandatoryFields: z.array(z.enum(fields)).max(20), mandatoryDocuments: z.array(z.enum(documents)).max(4), contactPhone: z.string().trim().max(20).default("") })).handler(async ({ data }) => {
  const { DB } = bindings(); if (!DB) return { ok: false as const, message: "Database unavailable." };
  const user = await manager(DB, data.token); if (!user || user.role !== "Admin") return { ok: false as const, message: "Admin access required." };
  const property = await DB.prepare("SELECT id FROM properties WHERE name=?").bind(data.property).first(); if (!property) return { ok: false as const, message: "Property not found." };
  if (data.mandatoryFields.includes("aadhaar") && !data.mandatoryDocuments.includes("aadhaar")) return { ok: false as const, message: "If Aadhaar is mandatory, add Aadhaar to mandatory documents too." };
  if (data.mandatoryFields.includes("company_college_id") && !data.mandatoryDocuments.includes("company_college_id")) return { ok: false as const, message: "If Company / College ID is mandatory, add it to mandatory documents too." };
  const contact = data.contactPhone.replace(/\D/g, "");
  if (contact && !/^[6-9]\d{9}$/.test(contact)) return { ok: false as const, message: "Enter a valid 10-digit property contact number." };
  await DB.prepare("INSERT INTO property_onboarding_configs(property,mandatory_fields_json,mandatory_documents_json,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(property) DO UPDATE SET mandatory_fields_json=excluded.mandatory_fields_json,mandatory_documents_json=excluded.mandatory_documents_json,updated_at=datetime('now')").bind(data.property, JSON.stringify(data.mandatoryFields), JSON.stringify(data.mandatoryDocuments)).run();
  await DB.prepare("UPDATE properties SET contact_phone=?,updated_at=datetime('now') WHERE name=?").bind(contact, data.property).run();
  return { ok: true as const, message: "Property onboarding rules and contact number saved." };
});

export const copyPropertyOnboardingConfig = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, sourceProperty: z.string().trim().min(1).max(180), targetProperties: z.array(z.string().trim().min(1).max(180)).min(1).max(50) })).handler(async ({ data }) => {
  const { DB } = bindings(); if (!DB) return { ok: false as const, message: "Database unavailable." };
  const user = await manager(DB, data.token); if (!user || user.role !== "Admin") return { ok: false as const, message: "Admin access required." };
  const sourceExists = await DB.prepare("SELECT id FROM properties WHERE name=?").bind(data.sourceProperty).first();
  if (!sourceExists) return { ok: false as const, message: "Source property not found." };
  const targets = [...new Set(data.targetProperties)].filter(p => p !== data.sourceProperty);
  if (!targets.length) return { ok: false as const, message: "Choose at least one different target property." };
  for (const target of targets) {
    const exists = await DB.prepare("SELECT id FROM properties WHERE name=?").bind(target).first();
    if (!exists) return { ok: false as const, message: `Target property not found: ${target}. No configurations were copied.` };
  }
  const source = await configFor(DB, data.sourceProperty);
  const statements = targets.map(target => DB.prepare("INSERT INTO property_onboarding_configs(property,mandatory_fields_json,mandatory_documents_json,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(property) DO UPDATE SET mandatory_fields_json=excluded.mandatory_fields_json,mandatory_documents_json=excluded.mandatory_documents_json,updated_at=datetime('now')").bind(target, JSON.stringify(source.mandatoryFields), JSON.stringify(source.mandatoryDocuments)));
  try { await DB.batch(statements); } catch { return { ok: false as const, message: "Configuration copy failed. No target should be treated as updated; refresh and retry." }; }
  return { ok: true as const, message: `Onboarding configuration copied to ${targets.length} selected propert${targets.length===1?"y":"ies"}.` };
});

export const getTenantOnboardingAdmin = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, tenantId: z.number().int().positive() })).handler(async ({ data }) => {
  const { DB } = bindings(); if (!DB) return { ok: false as const, profile: null, message: "Database unavailable." };
  if (!await manager(DB, data.token)) return { ok: false as const, profile: null, message: "Please sign in again." };
  const id = realId(data.tenantId);
  const row = await DB.prepare("SELECT blood_group,guardian_name,guardian_phone,occupation,permanent_address,emergency_contact_name,emergency_contact_phone,aadhaar_ciphertext,aadhaar_last4,submitted_at,updated_at FROM tenant_onboarding_profiles WHERE tenant_id=?").bind(id).first<any>();
  const t = await DB.prepare("SELECT property,full_name,phone FROM tenants WHERE id=?").bind(id).first<any>();
  if (!t) return { ok: false as const, profile: null, message: "Tenant not found." };
  return { ok: true as const, profile: { ...(row || { blood_group:"",guardian_name:"",guardian_phone:"",occupation:"",permanent_address:"",emergency_contact_name:"",emergency_contact_phone:"",submitted_at:null }), aadhaar_number_masked: row?.aadhaar_last4 ? `XXXX XXXX ${row.aadhaar_last4}` : maskAadhaar(row?.aadhaar_ciphertext||"") }, tenant: t };
});

export const saveTenantOnboardingAdmin = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, tenantId: z.number().int().positive(), profile: profileSchema })).handler(async ({ data }) => {
  const { DB } = bindings(); if (!DB) return { ok: false as const, message: "Database unavailable." };
  const user = await manager(DB, data.token); if (!user || user.role !== "Admin") return { ok: false as const, message: "Admin access required." };
  const id = realId(data.tenantId);
  const tenant = await DB.prepare("SELECT property FROM tenants WHERE id=?").bind(id).first<any>(); if (!tenant) return { ok: false as const, message: "Tenant not found." };
  const p = data.profile;
  await DB.prepare("INSERT INTO tenant_onboarding_profiles(tenant_id,property,blood_group,guardian_name,guardian_phone,occupation,permanent_address,emergency_contact_name,emergency_contact_phone,updated_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(tenant_id) DO UPDATE SET property=excluded.property,blood_group=excluded.blood_group,guardian_name=excluded.guardian_name,guardian_phone=excluded.guardian_phone,occupation=excluded.occupation,permanent_address=excluded.permanent_address,emergency_contact_name=excluded.emergency_contact_name,emergency_contact_phone=excluded.emergency_contact_phone,updated_at=datetime('now')").bind(id,tenant.property,p.bloodGroup,p.guardianName,p.guardianPhone,p.occupation,p.permanentAddress,p.emergencyContactName,p.emergencyContactPhone).run();
  return { ok: true as const, message: "Tenant details updated by admin." };
});

export const saveTenantOnboardingFromPortal = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, profile: profileSchema })).handler(async ({ data }) => {
  const { DB } = bindings(); if (!DB) return { ok: false as const, message: "Portal unavailable." };
  const tenant = await sessionTenantForPayments(data.token); if (!tenant) return { ok: false as const, message: "Session expired. Please sign in again." };
  const existing = await DB.prepare("SELECT * FROM tenant_onboarding_profiles WHERE tenant_id=?").bind(tenant.id).first<any>();
  const config = await configFor(DB, tenant.property);
  if (existing?.submitted_at) {
    const oldDocs = await DB.prepare("SELECT document_type FROM tenant_kyc_documents WHERE tenant_id=? AND is_current=1 AND review_status!='Rejected'").bind(tenant.id).all<{document_type:string}>();
    const oldTypes = new Set((oldDocs.results||[]).map(row=>row.document_type));
    const oldValues:Record<string,string>={permanent_address:existing.permanent_address||"",emergency_contact_name:existing.emergency_contact_name||"",emergency_contact_phone:existing.emergency_contact_phone||"",blood_group:existing.blood_group||"",guardian_name:existing.guardian_name||"",guardian_phone:existing.guardian_phone||"",occupation:existing.occupation||""};
    const docFields=["profile_photo","aadhaar","company_college_id"];
    const oldComplete=config.mandatoryFields.every(key=>docFields.includes(key)?oldTypes.has(key):!!String(oldValues[key]||"").trim())&&config.mandatoryDocuments.every(key=>oldTypes.has(key));
    if(oldComplete)return {ok:false as const,message:"Your onboarding has already been submitted. Contact management if any detail needs correction."};
  }
  const p = data.profile;
  let aadhaarCiphertext = existing?.aadhaar_ciphertext || "";
  let aadhaarLast4 = existing?.aadhaar_last4 || "";
  if (p.aadhaarNumber) { try { aadhaarCiphertext = await encryptAadhaar(p.aadhaarNumber); aadhaarLast4 = p.aadhaarNumber.slice(-4); } catch (e) { return { ok:false as const, message: e instanceof Error ? e.message : "Aadhaar encryption is unavailable." }; } }
  const values: Record<string,string> = { permanent_address:p.permanentAddress, emergency_contact_name:p.emergencyContactName, emergency_contact_phone:p.emergencyContactPhone, blood_group:p.bloodGroup, guardian_name:p.guardianName, guardian_phone:p.guardianPhone, occupation:p.occupation };
  for (const key of config.mandatoryFields) {
    if (["profile_photo","aadhaar","company_college_id"].includes(key)) {
      const doc = await DB.prepare("SELECT id FROM tenant_kyc_documents WHERE tenant_id=? AND document_type=? AND is_current=1 AND review_status!='Rejected' LIMIT 1").bind(tenant.id,key).first();
      if (!doc) return { ok: false as const, message: `Upload your ${key === "profile_photo" ? "profile photo" : key === "aadhaar" ? "Aadhaar" : "Company / College ID"} before submitting onboarding.` };
    } else if (!String(values[key] || "").trim()) return { ok: false as const, message: `Please complete the required field: ${key.replaceAll("_"," ")}.` };
  }
  for (const key of config.mandatoryDocuments) {
    const doc = await DB.prepare("SELECT id FROM tenant_kyc_documents WHERE tenant_id=? AND document_type=? AND is_current=1 AND review_status!='Rejected' LIMIT 1").bind(tenant.id,key).first();
    if (!doc) return { ok: false as const, message: `Please upload your ${key === "aadhaar" ? "Aadhaar" : key === "company_college_id" ? "Company / College ID" : key === "profile_photo" ? "profile photo" : "required document"}.` };
  }
  await DB.prepare("INSERT INTO tenant_onboarding_profiles(tenant_id,property,blood_group,guardian_name,guardian_phone,occupation,permanent_address,emergency_contact_name,emergency_contact_phone,aadhaar_ciphertext,aadhaar_last4,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT submitted_at FROM tenant_onboarding_profiles WHERE tenant_id=?),datetime('now')),datetime('now')) ON CONFLICT(tenant_id) DO UPDATE SET property=excluded.property,blood_group=excluded.blood_group,guardian_name=excluded.guardian_name,guardian_phone=excluded.guardian_phone,occupation=excluded.occupation,permanent_address=excluded.permanent_address,emergency_contact_name=excluded.emergency_contact_name,emergency_contact_phone=excluded.emergency_contact_phone,aadhaar_ciphertext=CASE WHEN excluded.aadhaar_ciphertext!='' THEN excluded.aadhaar_ciphertext ELSE tenant_onboarding_profiles.aadhaar_ciphertext END,aadhaar_last4=CASE WHEN excluded.aadhaar_last4!='' THEN excluded.aadhaar_last4 ELSE tenant_onboarding_profiles.aadhaar_last4 END,submitted_at=COALESCE(tenant_onboarding_profiles.submitted_at,datetime('now')),updated_at=datetime('now')").bind(tenant.id,tenant.property,p.bloodGroup,p.guardianName,p.guardianPhone,p.occupation,p.permanentAddress,p.emergencyContactName,p.emergencyContactPhone,aadhaarCiphertext,aadhaarLast4,tenant.id).run();
  await DB.prepare("UPDATE tenants SET kyc_status='Submitted',updated_at=datetime('now') WHERE id=? AND kyc_status!='Verified'").bind(tenant.id).run();
  return { ok: true as const, message: "Onboarding submitted. Your dashboard is now available while management reviews your documents." };
});

export const reviewTenantKycDocument = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, documentId: z.number().int().positive(), status: z.enum(["Approved","Rejected"]), reason: z.string().trim().max(500).default("") })).handler(async ({ data }) => {
  const { DB } = bindings(); if (!DB) return { ok: false as const, message: "Database unavailable." };
  const user = await manager(DB, data.token); if (!user) return { ok: false as const, message: "Please sign in again." };
  if (data.status === "Rejected" && data.reason.length < 3) return { ok: false as const, message: "Enter a clear reason for rejecting this document." };
  const doc = await DB.prepare("SELECT id,tenant_id,property,document_type,is_current FROM tenant_kyc_documents WHERE id=?").bind(data.documentId).first<any>();
  if (!doc) return { ok: false as const, message: "Document not found." };
  if (!doc.is_current) return { ok: false as const, message: "This is an older document version. Review the latest uploaded version instead." };
  const reviewed = await DB.prepare("UPDATE tenant_kyc_documents SET review_status=?,review_note=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=? AND is_current=1").bind(data.status,data.reason,user.name,data.documentId).run();
  if (Number(reviewed.meta?.changes||0)<1) return { ok: false as const, message: "This document has changed. Refresh the tenant's KYC list and try again." };
  if (data.status === "Rejected") await DB.prepare("UPDATE tenants SET kyc_status='Rejected',updated_at=datetime('now') WHERE id=?").bind(doc.tenant_id).run();
  else {
    const rejected = await DB.prepare("SELECT id FROM tenant_kyc_documents WHERE tenant_id=? AND is_current=1 AND review_status='Rejected' LIMIT 1").bind(doc.tenant_id).first();
    if (!rejected) await DB.prepare("UPDATE tenants SET kyc_status=CASE WHEN kyc_status='Rejected' THEN 'Submitted' ELSE kyc_status END,updated_at=datetime('now') WHERE id=?").bind(doc.tenant_id).run();
  }
  return { ok: true as const, message: data.status === "Approved" ? "Document approved." : "Document rejected. The tenant can now replace it." };
});

export const getTenantAdminContact = createServerFn({ method: "POST" }).validator(z.object({ phone: z.string().trim().max(20).default("") })).handler(async ({ data }) => {
  const { DB } = bindings(); if (!DB) return { phone: "7200352252" };
  const digits = data.phone.replace(/\D/g, "").slice(-10);
  if (digits) {
    const tenant = await DB.prepare("SELECT property FROM tenants WHERE replace(replace(phone,'+91',''),' ','') LIKE ? AND status!='Vacated' LIMIT 1").bind(`%${digits}`).first<any>();
    if (tenant) {
      const p = await DB.prepare("SELECT contact_phone FROM properties WHERE name=?").bind(tenant.property).first<any>();
      const contact = String(p?.contact_phone || "").replace(/\D/g, "");
      if (/^[6-9]\d{9}$/.test(contact)) return { phone: contact };
    }
  }
  return { phone: "7200352252" };
});
