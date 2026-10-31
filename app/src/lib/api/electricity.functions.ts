import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";

type ElectricityBillRow = { property: string; room: string; billing_period: string; initial_reading: number; final_reading: number; rate_per_unit: number; units_used: number; total_amount: number; members_json: string; updated_at: string; final_reading_date?: string | null };
type RoomMeterRow = { id: number; property: string; room: string; meter_number: string; default_rate: number; member_names: string; initial_reading: number; final_reading: number; rate_per_unit: number; members_json: string; previous_reading: number | null; active: number; updated_at: string | null };

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a valid billing month.");
const memberSchema = z.object({ name: z.string().trim().min(1).max(120), share: z.number().finite().nonnegative().max(10000000) });
const billSchema = z.object({
  property: z.string().trim().min(1).max(180), room: z.string().trim().min(1).max(80),
  initial: z.number().finite().nonnegative().max(1000000000), final: z.number().finite().nonnegative().max(1000000000), rate: z.number().finite().nonnegative().max(100000),
  units: z.number().finite().nonnegative().max(1000000000), total: z.number().finite().nonnegative().max(10000000000), members: z.array(memberSchema).max(100), finalReadingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), photo: z.string().max(2200000).optional().default(""),
}).superRefine((bill, ctx) => {
  if (bill.final < bill.initial) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["final"], message: "Final meter reading cannot be lower than the initial reading." });
  const units = bill.final - bill.initial;
  if (Math.abs(bill.units - units) > 0.01) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["units"], message: "Units must equal final reading minus initial reading." });
  if (Math.abs(bill.total - units * bill.rate) > 0.02) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["total"], message: "Bill total must equal units multiplied by the rate." });
  const names = bill.members.map((m) => m.name.toLocaleLowerCase());
  if (new Set(names).size !== names.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["members"], message: "Member names must be unique within a room." });
});

const roomMeterInput = z.object({
  property: z.string().trim().min(1).max(180), room: z.string().trim().min(1).max(80),
  meterNumber: z.string().trim().max(80).default(""), rate: z.number().finite().nonnegative().max(100000),
  members: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
});

export const createRoomMeter = createServerFn({ method: "POST" })
  .validator(roomMeterInput)
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, message: "Database is not enabled for this deployment." };
    const names = data.members.map((n) => n.trim());
    if (new Set(names.map((n) => n.toLocaleLowerCase())).size !== names.length) return { ok: false, message: "Remove duplicate member names before saving." };
    try {
      await DB.prepare(`INSERT INTO room_meters (property, room, meter_number, default_rate, member_names, active, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`)
        .bind(data.property, data.room, data.meterNumber, data.rate, names.join(", ")).run();
      return { ok: true, message: `Meter for ${data.room} was added.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/unique|constraint/i.test(message)) return { ok: false, message: "A meter is already registered for this room in this property." };
      throw error;
    }
  });

export const getRoomMeters = createServerFn({ method: "POST" })
  .validator(z.object({ property: z.string().optional(), period: periodSchema }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, rows: [], message: "Database is not enabled for this deployment." };
    // Register every active room from the shared inventory as an electricity meter automatically.
    // Existing meter rows/readings are preserved by INSERT OR IGNORE.
    await DB.prepare(`INSERT OR IGNORE INTO room_meters (property, room, meter_number, default_rate, member_names, active, updated_at)
      SELECT r.property, r.room, '', 11, '', 1, datetime('now') FROM rooms r WHERE r.active=1${data.property && data.property !== "All Properties" ? " AND r.property=?" : ""}`)
      .bind(...(data.property && data.property !== "All Properties" ? [data.property] : [])).run();
    const sql = `SELECT m.id, m.property, m.room, m.meter_number, m.default_rate,
      COALESCE((SELECT group_concat(t.full_name, ', ') FROM tenants t WHERE t.property=m.property AND (lower(t.room)=lower(m.room) OR lower(t.room) LIKE lower(m.room || ' /%')) AND t.status NOT IN ('Vacated','Booked')), m.member_names) AS member_names,
      COALESCE(
        (SELECT b2.final_reading FROM electricity_bills b2 WHERE lower(b2.property)=lower(m.property) AND lower(b2.room)=lower(m.room) AND b2.billing_period<? ORDER BY b2.billing_period DESC LIMIT 1),
        current.initial_reading, 0) AS initial_reading,
      CASE WHEN current.id IS NULL THEN '' ELSE current.final_reading END AS final_reading,
      COALESCE(current.rate_per_unit, m.default_rate) AS rate_per_unit,
      COALESCE(current.members_json, '[]') AS current_members_json,
      (SELECT b3.final_reading FROM electricity_bills b3 WHERE lower(b3.property)=lower(m.property) AND lower(b3.room)=lower(m.room) AND b3.billing_period<? ORDER BY b3.billing_period DESC LIMIT 1) AS previous_reading,
      (SELECT COALESCE(b4.final_reading_date,substr(b4.updated_at,1,10)) FROM electricity_bills b4 WHERE lower(b4.property)=lower(m.property) AND lower(b4.room)=lower(m.room) AND b4.billing_period<? ORDER BY b4.billing_period DESC LIMIT 1) AS previous_reading_date,
      m.active, current.updated_at
      FROM room_meters m
      LEFT JOIN electricity_bills current ON lower(current.property)=lower(m.property) AND lower(current.room)=lower(m.room) AND current.billing_period=?
      WHERE m.active=1${data.property && data.property !== "All Properties" ? " AND m.property=?" : ""}
      ORDER BY m.property, m.room LIMIT 500`;
    const values = data.property && data.property !== "All Properties"
      ? [data.period, data.period, data.period, data.period, data.property]
      : [data.period, data.period, data.period, data.period];
    const result = await DB.prepare(sql).bind(...values).all<RoomMeterRow & { current_members_json: string }>();
    return { ok: true, rows: (result.results ?? []).map((row) => ({ ...row, members_json: row.current_members_json && row.current_members_json !== "[]" ? row.current_members_json : JSON.stringify(row.member_names.split(",").map((name) => name.trim()).filter(Boolean).map((name) => ({ name, share: 0 }))) })) };
  });

export const saveElectricityBills = createServerFn({ method: "POST" })
  .validator(z.object({ period: periodSchema, bills: z.array(billSchema).min(1).max(300) }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, message: "Database is not enabled for this deployment." };
    const keys = data.bills.map((b) => `${b.property.toLocaleLowerCase()}|${b.room.toLocaleLowerCase()}`);
    if (new Set(keys).size !== keys.length) return { ok: false, message: "The same room appears more than once in this save. Refresh and try again." };
    const statements = data.bills.flatMap((bill) => [
      DB.prepare(`INSERT INTO room_meters (property, room, default_rate, member_names, active, updated_at)
        VALUES (?, ?, ?, ?, 1, datetime('now'))
        ON CONFLICT(property, room) DO UPDATE SET default_rate=excluded.default_rate, member_names=excluded.member_names, updated_at=datetime('now')`)
        .bind(bill.property, bill.room, bill.rate, bill.members.map((m) => m.name).join(", ")),
      DB.prepare(`INSERT INTO electricity_bills (property, room, billing_period, initial_reading, final_reading, rate_per_unit, units_used, total_amount, members_json, meter_photo_data, final_reading_date, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(property, room, billing_period) DO UPDATE SET initial_reading=excluded.initial_reading, final_reading=excluded.final_reading, final_reading_date=excluded.final_reading_date,
        rate_per_unit=excluded.rate_per_unit, units_used=excluded.units_used, total_amount=excluded.total_amount, members_json=excluded.members_json,
        meter_photo_data=CASE WHEN excluded.meter_photo_data='' THEN electricity_bills.meter_photo_data ELSE excluded.meter_photo_data END, updated_at=datetime('now')`)
        .bind(bill.property, bill.room, data.period, bill.initial, bill.final, bill.rate, bill.units, bill.total, JSON.stringify(bill.members), bill.photo, bill.finalReadingDate ?? new Date().toISOString().slice(0,10)),
    ]);
    await DB.batch(statements);
    return { ok: true, saved: data.bills.length, period: data.period };
  });

export const getElectricityBills = createServerFn({ method: "POST" })
  .validator(z.object({ property: z.string().optional(), period: periodSchema.optional() }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, rows: [], message: "Database is not enabled for this deployment." };
    let sql = "SELECT property, room, billing_period, initial_reading, final_reading, rate_per_unit, units_used, total_amount, members_json, updated_at, final_reading_date FROM electricity_bills WHERE 1=1";
    const values: string[] = [];
    if (data.property && data.property !== "All Properties") { sql += " AND property = ?"; values.push(data.property); }
    if (data.period) { sql += " AND billing_period = ?"; values.push(data.period); }
    sql += " ORDER BY billing_period DESC, property ASC, room ASC LIMIT 2000";
    const result = await DB.prepare(sql).bind(...values).all<ElectricityBillRow>();
    return { ok: true, rows: result.results ?? [] };
  });

const allocationSchema = z.object({
  property: z.string().trim().min(1).max(180), room: z.string().trim().min(1).max(80),
  tenantName: z.string().trim().min(1).max(120), tenantPhone: z.string().max(30).optional().default(""),
  amount: z.number().finite().nonnegative().max(10000000),
});
type ElectricityDueRow = { property: string; room: string; billing_period: string; tenant_name: string; tenant_phone: string; amount: number; paid_amount: number; status: string; updated_at: string };

export const postElectricityDues = createServerFn({ method: "POST" })
  .validator(z.object({ period: periodSchema, allocations: z.array(allocationSchema).min(1).max(500) }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, message: "Database is not enabled for this deployment." };
    const statements = data.allocations.map((item) => DB.prepare(
      `INSERT INTO tenant_electricity_dues (property, room, billing_period, tenant_name, tenant_phone, amount, paid_amount, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'unpaid', datetime('now'))
       ON CONFLICT(property, room, billing_period, tenant_name) DO UPDATE SET tenant_phone=excluded.tenant_phone,
       amount=excluded.amount, paid_amount=MIN(tenant_electricity_dues.paid_amount, excluded.amount),
       status=CASE WHEN MIN(tenant_electricity_dues.paid_amount, excluded.amount) >= excluded.amount THEN 'paid' ELSE 'unpaid' END,
       updated_at=datetime('now')`
    ).bind(item.property, item.room, data.period, item.tenantName, item.tenantPhone ?? "", item.amount));
    await DB.batch(statements);
    return { ok: true, posted: data.allocations.length, period: data.period };
  });

export const getElectricityDues = createServerFn({ method: "POST" })
  .validator(z.object({ property: z.string().optional(), period: periodSchema.optional() }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, rows: [], message: "Database is not enabled for this deployment." };
    let sql = "SELECT property, room, billing_period, tenant_name, tenant_phone, amount, paid_amount, status, updated_at FROM tenant_electricity_dues WHERE 1=1";
    const values: string[] = [];
    if (data.property && data.property !== "All Properties") { sql += " AND property = ?"; values.push(data.property); }
    if (data.period) { sql += " AND billing_period = ?"; values.push(data.period); }
    sql += " ORDER BY billing_period DESC, property ASC, room ASC, tenant_name ASC LIMIT 500";
    const result = await DB.prepare(sql).bind(...values).all<ElectricityDueRow>();
    return { ok: true, rows: result.results ?? [] };
  });

export const applyElectricityPayment = createServerFn({ method: "POST" })
  .validator(z.object({ property: z.string().min(1), tenantName: z.string().min(1), amount: z.number().positive() }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, applied: 0, message: "Database is not enabled for this deployment." };
    const result = await DB.prepare("SELECT id, amount, paid_amount FROM tenant_electricity_dues WHERE property = ? AND tenant_name = ? AND status = 'unpaid' ORDER BY billing_period ASC, id ASC")
      .bind(data.property, data.tenantName).all<{id:number;amount:number;paid_amount:number}>();
    let remaining = data.amount;
    const statements = [];
    for (const row of result.results ?? []) {
      if (remaining <= 0) break;
      const applied = Math.min(Math.max(0, row.amount - row.paid_amount), remaining);
      if (applied <= 0) continue;
      const newPaid = row.paid_amount + applied;
      statements.push(DB.prepare("UPDATE tenant_electricity_dues SET paid_amount = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(newPaid, newPaid >= row.amount ? "paid" : "unpaid", row.id));
      remaining -= applied;
    }
    if (statements.length) await DB.batch(statements);
    return { ok: true, applied: data.amount - remaining };
  });


// One transactional operation for the room-meter workflow. Keeping the room bill,
// legacy electricity dues and unified Passbook charges in one D1 batch prevents
// a partial save from leaving the three views out of sync.
async function electricityManagerSession(DB: any, token: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode("wink-session-v1"), iterations: 100000, hash: "SHA-256" }, key, 256);
  const hash = Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return DB.prepare("SELECT a.phone FROM manager_pin_sessions s JOIN manager_pin_accounts a ON a.phone=s.phone WHERE s.token_hash=? AND s.expires_at>datetime('now') AND a.must_change_pin=0").bind(hash).first();
}

export const saveRoomElectricityAndPostDues = createServerFn({ method: "POST" })
  .validator(z.object({
    token: z.string().min(20).max(128),
    period: periodSchema,
    bill: billSchema,
    tenantPhones: z.array(z.string().trim().min(10).max(20)).min(1).max(100),
    splitMode: z.enum(["Divide", "Each"]).default("Divide"),
  }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, message: "Database is not enabled for this deployment." };
    if (!await electricityManagerSession(DB, data.token)) return { ok: false, message: "Manager sign-in required. Please sign in again." };
    const { bill } = data;
    const phones = [...new Set(data.tenantPhones.map((value) => value.replace(/\D/g, "").slice(-10)))];
    if (phones.length !== data.tenantPhones.length) return { ok: false, message: "Each tenant must have a unique valid mobile number." };

    const placeholders = phones.map(() => "?").join(",");
    const occupants = await DB.prepare(
      `SELECT id, full_name, phone, room FROM tenants
       WHERE property=? AND replace(replace(phone,' ',''),'-','') IN (${placeholders})
       AND status NOT IN ('Vacated','Left','Booked')
       AND (lower(room)=lower(?) OR lower(room) LIKE lower(?))`
    ).bind(bill.property, ...phones, bill.room, `${bill.room} /%`).all<{id:number;full_name:string;phone:string;room:string}>();
    const tenants = occupants.results ?? [];
    if (tenants.length !== phones.length || new Set(tenants.map((tenant) => tenant.phone.replace(/\D/g, "").slice(-10))).size !== phones.length) {
      return { ok: false, message: "The room's active tenant list has changed. Refresh the room and try again." };
    }

    const shares = tenants.map((tenant, index) => ({
      tenant,
      amount: data.splitMode === "Each"
        ? bill.total
        : index === tenants.length - 1
          ? Math.round((bill.total - Math.round(bill.total / tenants.length * 100) / 100 * (tenants.length - 1)) * 100) / 100
          : Math.round(bill.total / tenants.length * 100) / 100,
    }));

    // Never reduce a charge below money already allocated to it. This protects
    // historical collections if an operator edits a previously posted bill.
    for (const share of shares) {
      const existing = await DB.prepare(
        "SELECT paid_amount FROM tenant_charges WHERE property=? AND tenant_phone=? AND billing_period=? AND charge_type='electricity' AND room=? LIMIT 1"
      ).bind(bill.property, share.tenant.phone, data.period, bill.room).first<{paid_amount:number}>();
      const legacy = await DB.prepare(
        "SELECT paid_amount FROM tenant_electricity_dues WHERE property=? AND room=? AND billing_period=? AND tenant_name=? LIMIT 1"
      ).bind(bill.property, bill.room, data.period, share.tenant.full_name).first<{paid_amount:number}>();
      if ((existing && Number(existing.paid_amount) > share.amount + 0.001) || (legacy && Number(legacy.paid_amount) > share.amount + 0.001)) {
        return { ok: false, message: `${share.tenant.full_name} has already paid more than the revised electricity share. Record a refund/adjustment before reducing this bill.` };
      }
    }

    const memberRows = shares.map(({ tenant, amount }) => ({ name: tenant.full_name, share: amount }));
    const statements = [
      DB.prepare(`INSERT INTO room_meters (property, room, default_rate, member_names, active, updated_at)
        VALUES (?, ?, ?, ?, 1, datetime('now'))
        ON CONFLICT(property, room) DO UPDATE SET default_rate=excluded.default_rate, member_names=excluded.member_names, active=1, updated_at=datetime('now')`)
        .bind(bill.property, bill.room, bill.rate, tenants.map((tenant) => tenant.full_name).join(", ")),
      DB.prepare(`INSERT INTO electricity_bills (property, room, billing_period, initial_reading, final_reading, rate_per_unit, units_used, total_amount, members_json, meter_photo_data, final_reading_date, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(property, room, billing_period) DO UPDATE SET initial_reading=excluded.initial_reading, final_reading=excluded.final_reading,
        final_reading_date=excluded.final_reading_date, rate_per_unit=excluded.rate_per_unit, units_used=excluded.units_used,
        total_amount=excluded.total_amount, members_json=excluded.members_json,
        meter_photo_data=CASE WHEN excluded.meter_photo_data='' THEN electricity_bills.meter_photo_data ELSE excluded.meter_photo_data END,
        updated_at=datetime('now')`)
        .bind(bill.property, bill.room, data.period, bill.initial, bill.final, bill.rate, bill.units, bill.total, JSON.stringify(memberRows), bill.photo, bill.finalReadingDate ?? new Date().toISOString().slice(0, 10)),
    ];

    for (const { tenant, amount } of shares) {
      statements.push(DB.prepare(`INSERT INTO tenant_electricity_dues (property, room, billing_period, tenant_name, tenant_phone, amount, paid_amount, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, 'unpaid', datetime('now'))
        ON CONFLICT(property, room, billing_period, tenant_name) DO UPDATE SET tenant_phone=excluded.tenant_phone,
        amount=excluded.amount, paid_amount=MIN(tenant_electricity_dues.paid_amount, excluded.amount),
        status=CASE WHEN MIN(tenant_electricity_dues.paid_amount, excluded.amount)>=excluded.amount THEN 'paid' ELSE 'unpaid' END,
        updated_at=datetime('now')`)
        .bind(bill.property, bill.room, data.period, tenant.full_name, tenant.phone, amount));
      statements.push(DB.prepare(`INSERT INTO tenant_charges (property, tenant_name, tenant_phone, room, billing_period, charge_type, description, amount, paid_amount, status, updated_at)
        VALUES (?, ?, ?, ?, ?, 'electricity', ?, ?, 0, CASE WHEN ?=0 THEN 'paid' ELSE 'unpaid' END, datetime('now'))
        ON CONFLICT(property, tenant_phone, billing_period, charge_type, room) DO UPDATE SET tenant_name=excluded.tenant_name,
        description=excluded.description, amount=excluded.amount,
        paid_amount=MIN(tenant_charges.paid_amount, excluded.amount),
        status=CASE WHEN MIN(tenant_charges.paid_amount, excluded.amount)>=excluded.amount THEN 'paid' ELSE 'unpaid' END,
        updated_at=datetime('now')`)
        .bind(bill.property, tenant.full_name, tenant.phone, bill.room, data.period, `${bill.room} · Electricity · ${data.period}`, amount, amount));
    }

    try {
      await DB.batch(statements);
    } catch {
      return { ok: false, message: "Nothing was posted because the room bill and tenant charges could not be saved together. Please refresh and retry." };
    }
    return { ok: true, saved: true, period: data.period, tenantCount: shares.length, total: bill.total, shares: shares.map(({ tenant, amount }) => ({ tenantId: tenant.id, name: tenant.full_name, amount })) };
  });
