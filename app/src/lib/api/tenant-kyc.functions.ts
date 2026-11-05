import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";
import { sessionTenantForPayments } from "./tenant-portal.server";

const tokenSchema = z.string().min(20).max(128);
const documentType = z.enum(["aadhaar", "company_college_id", "profile_photo", "other"]);
async function tokenHash(token: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode("wink-session-v1"), iterations: 100000, hash: "SHA-256" }, key, 256);
  return Array.from(new Uint8Array(bits), x => x.toString(16).padStart(2, "0")).join("");
}
async function manager(DB: any, token: string) {
  return DB.prepare("SELECT a.phone,a.name,a.role FROM manager_pin_sessions s JOIN manager_pin_accounts a ON a.phone=s.phone WHERE s.token_hash=? AND s.expires_at>datetime('now') AND a.must_change_pin=0").bind(await tokenHash(token)).first() as { phone: string; name: string; role: string } | null;
}
const realId = (id: number) => id >= 100000 ? id - 100000 : id;
function decodeFile(base64: string, contentType: string) {
  const raw = atob(base64);
  if (raw.length > 5 * 1024 * 1024) throw new Error("Maximum file size is 5 MB.");
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const valid = contentType === "application/pdf" ? new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-" : contentType === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff : bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!valid) throw new Error("The file content does not match its selected format.");
  return bytes;
}
function encodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const listTenantKycDocuments = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, tenantId: z.number().int().positive() })).handler(async ({ data }) => {
  const { DB } = bindings();
  if (!DB || !await manager(DB, data.token)) return { ok: false as const, documents: [], message: "Please sign in again." };
  const rows = await DB.prepare("SELECT id,document_name,content_type,file_size,uploaded_by,created_at,document_type,review_status,review_note,reviewed_by,reviewed_at,is_current FROM tenant_kyc_documents WHERE tenant_id=? ORDER BY created_at DESC,id DESC").bind(realId(data.tenantId)).all<any>();
  return { ok: true as const, documents: rows.results || [] };
});

export const uploadTenantKycDocument = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, tenantId: z.number().int().positive(), fileName: z.string().trim().min(1).max(180), contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]), documentType: documentType.default("aadhaar"), base64: z.string().min(1).max(7000000) })).handler(async ({ data }) => {
  const { DB, STORAGE } = bindings();
  if (!DB || !STORAGE) return { ok: false as const, message: "Secure storage is not enabled for this deployment." };
  const user = await manager(DB, data.token);
  if (!user) return { ok: false as const, message: "Please sign in again." };
  if (data.documentType === "profile_photo" && data.contentType === "application/pdf") return { ok: false as const, message: "A profile photo must be a JPG or PNG image." };
  const id = realId(data.tenantId);
  const tenant = await DB.prepare("SELECT id,property,full_name FROM tenants WHERE id=?").bind(id).first<any>();
  if (!tenant) return { ok: false as const, message: "Tenant not found." };
  let bytes: Uint8Array;
  try { bytes = decodeFile(data.base64, data.contentType); } catch (error) { return { ok: false as const, message: error instanceof Error ? error.message : "Invalid file." }; }
  const key = `tenant-kyc/${id}/${crypto.randomUUID()}`;
  await STORAGE.put(key, bytes, { httpMetadata: { contentType: data.contentType, contentDisposition: "attachment" } });
  await DB.prepare("UPDATE tenant_kyc_documents SET is_current=0 WHERE tenant_id=? AND document_type=? AND is_current=1").bind(id, data.documentType).run();
  const doc = await DB.prepare("INSERT INTO tenant_kyc_documents(tenant_id,property,tenant_name,document_name,content_type,object_key,file_size,uploaded_by,document_type,review_status,is_current) VALUES(?,?,?,?,?,?,?,?,?,'Pending',1) RETURNING id").bind(id, tenant.property, tenant.full_name, data.fileName, data.contentType, key, bytes.length, user.name, data.documentType).first<any>();
  await DB.prepare("UPDATE tenants SET kyc_status=CASE WHEN kyc_status='Verified' THEN 'Submitted' ELSE kyc_status END,updated_at=datetime('now') WHERE id=?").bind(id).run();
  if (data.documentType === "profile_photo" && data.contentType !== "application/pdf") await DB.prepare("INSERT INTO tenant_profile_photos(tenant_id,property,object_key,file_size,updated_at) VALUES(?,?,?,?,datetime('now')) ON CONFLICT(tenant_id) DO UPDATE SET property=excluded.property,object_key=excluded.object_key,file_size=excluded.file_size,updated_at=datetime('now')").bind(id, tenant.property, key, bytes.length).run();
  return { ok: true as const, documentId: doc?.id, message: "Replacement document uploaded securely and marked Pending review." };
});

export const downloadTenantKycDocument = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, documentId: z.number().int().positive() })).handler(async ({ data }) => {
  const { DB, STORAGE } = bindings();
  if (!DB || !STORAGE || !await manager(DB, data.token)) return { ok: false as const, message: "Please sign in again." };
  const doc = await DB.prepare("SELECT object_key,document_name,content_type,document_type FROM tenant_kyc_documents WHERE id=?").bind(data.documentId).first<{ object_key: string; document_name: string; content_type: string; document_type:string }>();
  if (!doc) return { ok: false as const, message: "Document not found." };
  const obj = await STORAGE.get(doc.object_key);
  if (!obj) return { ok: false as const, message: "Stored file not found." };
  return { ok: true as const, fileName: doc.document_name, contentType: doc.document_type === "profile_photo" ? (obj.httpMetadata?.contentType || doc.content_type) : doc.content_type, base64: encodeBytes(new Uint8Array(await obj.arrayBuffer())) };
});

export const uploadTenantProfilePhoto = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, fileName: z.string().trim().min(1).max(180), contentType: z.enum(["image/jpeg", "image/png"]), base64: z.string().min(1).max(7000000) })).handler(async ({ data }) => {
  const { DB, STORAGE } = bindings();
  if (!DB || !STORAGE) return { ok: false as const, message: "Secure photo storage is unavailable." };
  const tenant = await sessionTenantForPayments(data.token);
  if (!tenant) return { ok: false as const, message: "Your session expired. Please sign in again." };
  const current = await DB.prepare("SELECT review_status FROM tenant_kyc_documents WHERE tenant_id=? AND document_type='profile_photo' AND is_current=1").bind(tenant.id).first<any>();
  if (current && current.review_status !== "Rejected") return { ok: false as const, message: "Your profile photo is already submitted. You can replace it only if management rejects it." };
  let bytes: Uint8Array;
  try { bytes = decodeFile(data.base64, data.contentType); } catch (error) { return { ok: false as const, message: error instanceof Error ? error.message : "Invalid photo." }; }
  const key = `tenant-profile/${tenant.id}/${crypto.randomUUID()}`;
  await STORAGE.put(key, bytes, { httpMetadata: { contentType: data.contentType } });
  await DB.prepare("INSERT INTO tenant_profile_photos(tenant_id,property,object_key,file_size,updated_at) VALUES(?,?,?,?,datetime('now')) ON CONFLICT(tenant_id) DO UPDATE SET property=excluded.property,object_key=excluded.object_key,file_size=excluded.file_size,updated_at=datetime('now')").bind(tenant.id, tenant.property, key, bytes.length).run();
  await DB.prepare("UPDATE tenant_kyc_documents SET is_current=0 WHERE tenant_id=? AND document_type='profile_photo' AND is_current=1").bind(tenant.id).run();
  await DB.prepare("INSERT INTO tenant_kyc_documents(tenant_id,property,tenant_name,document_name,content_type,object_key,file_size,uploaded_by,document_type,review_status,is_current) VALUES(?,?,?,?,?,?,?,'Tenant','profile_photo','Pending',1)").bind(tenant.id, tenant.property, tenant.full_name, data.fileName, data.contentType, key, bytes.length).run();
  await DB.prepare("UPDATE tenants SET kyc_status=CASE WHEN kyc_status='Verified' THEN 'Submitted' ELSE kyc_status END,updated_at=datetime('now') WHERE id=?").bind(tenant.id).run();
  return { ok: true as const, message: "Profile photo uploaded and submitted for management review." };
});

export const getTenantProfilePhoto = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, tenantId: z.number().int().positive() })).handler(async ({ data }) => {
  const { DB, STORAGE } = bindings();
  if (!DB || !STORAGE || !await manager(DB, data.token)) return { ok: false as const, message: "Please sign in again." };
  const row = await DB.prepare("SELECT object_key FROM tenant_profile_photos WHERE tenant_id=?").bind(realId(data.tenantId)).first<{ object_key: string }>();
  if (!row) return { ok: true as const, base64: "", contentType: "" };
  const obj = await STORAGE.get(row.object_key);
  if (!obj) return { ok: false as const, message: "Profile photo not found." };
  return { ok: true as const, base64: encodeBytes(new Uint8Array(await obj.arrayBuffer())), contentType: obj.httpMetadata?.contentType || "image/jpeg" };
});

export const uploadTenantKycDocumentFromPortal = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, fileName: z.string().trim().min(1).max(180), contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]), documentType: documentType.exclude(["profile_photo"]).default("aadhaar"), base64: z.string().min(1).max(7000000) })).handler(async ({ data }) => {
  const { DB, STORAGE } = bindings();
  if (!DB || !STORAGE) return { ok: false as const, message: "Secure document storage is unavailable." };
  const tenant = await sessionTenantForPayments(data.token);
  if (!tenant) return { ok: false as const, message: "Your session expired. Please sign in again." };
  const profile = await DB.prepare("SELECT submitted_at FROM tenant_onboarding_profiles WHERE tenant_id=?").bind(tenant.id).first<any>();
  const current = data.documentType === "other" ? null : await DB.prepare("SELECT review_status FROM tenant_kyc_documents WHERE tenant_id=? AND document_type=? AND is_current=1").bind(tenant.id, data.documentType).first<any>();
  if (data.documentType !== "other" && current && current.review_status !== "Rejected") return { ok: false as const, message: "This document is already submitted. You can replace it only after management rejects it." };
  let bytes: Uint8Array;
  try { bytes = decodeFile(data.base64, data.contentType); } catch (error) { return { ok: false as const, message: error instanceof Error ? error.message : "Invalid file." }; }
  const key = `tenant-kyc/${tenant.id}/${crypto.randomUUID()}`;
  await STORAGE.put(key, bytes, { httpMetadata: { contentType: data.contentType, contentDisposition: "attachment" } });
  if (data.documentType !== "other") await DB.prepare("UPDATE tenant_kyc_documents SET is_current=0 WHERE tenant_id=? AND document_type=? AND is_current=1").bind(tenant.id, data.documentType).run();
  await DB.prepare("INSERT INTO tenant_kyc_documents(tenant_id,property,tenant_name,document_name,content_type,object_key,file_size,uploaded_by,document_type,review_status,is_current) VALUES(?,?,?,?,?,?,?,'Tenant',?,'Pending',1)").bind(tenant.id, tenant.property, tenant.full_name, data.fileName, data.contentType, key, bytes.length, data.documentType).run();
  await DB.prepare("UPDATE tenants SET kyc_status=CASE WHEN kyc_status='Verified' THEN 'Submitted' ELSE kyc_status END,updated_at=datetime('now') WHERE id=?").bind(tenant.id).run();
  return { ok: true as const, message: "Document uploaded securely and submitted for management review." };
});

export const downloadTenantKycDocumentFromPortal = createServerFn({ method: "POST" }).validator(z.object({ token: tokenSchema, documentId: z.number().int().positive() })).handler(async ({ data }) => {
  const { DB, STORAGE } = bindings();
  if (!DB || !STORAGE) return { ok: false as const, message: "Document storage is unavailable." };
  const tenant = await sessionTenantForPayments(data.token);
  if (!tenant) return { ok: false as const, message: "Your session has expired. Please sign in again." };
  const doc = await DB.prepare("SELECT object_key,document_name,content_type FROM tenant_kyc_documents WHERE id=? AND tenant_id=? AND is_current=1").bind(data.documentId, tenant.id).first<{ object_key: string; document_name: string; content_type: string }>();
  if (!doc) return { ok: false as const, message: "Document not found." };
  const obj = await STORAGE.get(doc.object_key);
  if (!obj) return { ok: false as const, message: "Stored file not found." };
  return { ok: true as const, fileName: doc.document_name, contentType: obj.httpMetadata?.contentType || doc.content_type, base64: encodeBytes(new Uint8Array(await obj.arrayBuffer())) };
});
