import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";

const settingsSchema = z.object({
  propertyDisplayName: z.string().trim().min(1).max(120),
  rentOkId: z.string().trim().max(80),
  upiId: z.string().trim().max(100).default("").refine(v => !v || /^[A-Za-z0-9._-]{2,80}@[A-Za-z][A-Za-z0-9.-]{1,30}$/.test(v), "Enter a valid UPI ID, such as name@okaxis."),
  kycMandatoryFields: z.array(z.enum(["Profile photo","Government ID"])).max(4).default(["Profile photo","Government ID"]),
  tenantType: z.enum(["Working professionals", "Students", "Mixed"]),
  curfew: z.enum(["09:00 PM", "09:30 PM", "10:00 PM", "10:30 PM", "11:00 PM", "No curfew"]),
  lateFee: z.number().min(0).max(10000),
  lateFeeEnabled: z.boolean().default(false),
  electricityRate: z.number().min(0).max(10000),
  rentDueDay: z.number().int().min(1).max(28),
});
export type AppSettings = z.infer<typeof settingsSchema>;
export const defaultAppSettings: AppSettings = { propertyDisplayName: "Wink Hostels", rentOkId: "WINK-PG-CHN-001", upiId: "", kycMandatoryFields: ["Profile photo","Government ID"], tenantType: "Working professionals", curfew: "10:00 PM", lateFee: 50, lateFeeEnabled: false, electricityRate: 12, rentDueDay: 10 };
export const getAppSettings = createServerFn({ method: "POST" }).handler(async () => {
  const { DB } = bindings();
  if (!DB) return { ok: false as const, settings: defaultAppSettings, message: "Database is not enabled." };
  const result = await DB.prepare("SELECT setting_value FROM app_settings WHERE setting_key='business-settings'").first<{setting_value:string}>();
  if (!result) return { ok: true as const, settings: defaultAppSettings };
  try { return { ok: true as const, settings: settingsSchema.parse(JSON.parse(result.setting_value)) }; }
  catch { return { ok: true as const, settings: defaultAppSettings }; }
});
export const saveAppSettings = createServerFn({ method: "POST" }).validator(settingsSchema).handler(async ({ data }) => {
  const { DB } = bindings();
  if (!DB) return { ok: false as const, message: "Database is not enabled for this deployment." };
  const current = await DB.prepare("SELECT setting_value FROM app_settings WHERE setting_key='business-settings'").first<{setting_value:string}>();
  let currentUpiId = "";
  try { currentUpiId = String(JSON.parse(current?.setting_value || "{}").upiId || "").trim(); } catch {}
  const safeSettings = { ...data, upiId: currentUpiId };
  await DB.prepare("INSERT INTO app_settings(setting_key,setting_value,updated_at) VALUES('business-settings',?,datetime('now')) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=datetime('now')").bind(JSON.stringify(safeSettings)).run();
  return { ok: true as const, settings: safeSettings };
});


export const savePropertyUpiId = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().min(20).max(128), upiId: z.string().trim().max(100).refine(v => !v || /^[A-Za-z0-9._-]{2,80}@[A-Za-z][A-Za-z0-9.-]{1,30}$/.test(v), "Enter a valid UPI ID.") }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false as const, message: "Database is not enabled." };
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(data.token), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode("wink-session-v1"), iterations: 100000, hash: "SHA-256" }, key, 256);
    const tokenHash = Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, "0")).join("");
    const manager = await DB.prepare("SELECT a.role FROM manager_pin_sessions s JOIN manager_pin_accounts a ON a.phone=s.phone WHERE s.token_hash=? AND s.expires_at>datetime('now') AND a.must_change_pin=0").bind(tokenHash).first<{role:string}>();
    if (manager?.role !== "Admin") return { ok: false as const, message: "Admin access required to change the payment UPI ID." };
    const current = await DB.prepare("SELECT setting_value FROM app_settings WHERE setting_key='business-settings'").first<{setting_value:string}>();
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(current?.setting_value || "{}"); } catch {}
    const next = { ...settings, upiId: data.upiId };
    await DB.prepare("INSERT INTO app_settings(setting_key,setting_value,updated_at) VALUES('business-settings',?,datetime('now')) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=datetime('now')").bind(JSON.stringify(next)).run();
    return { ok: true as const, upiId: data.upiId };
  });
