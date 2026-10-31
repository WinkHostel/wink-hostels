import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";

type RoomRow = { id: number; property: string; room: string; bed_capacity: number; floor: string; active: number };
const roomInput = z.object({ property: z.string().trim().min(1).max(180), room: z.string().trim().min(1).max(80), capacity: z.number().int().min(1).max(20), floor: z.string().trim().min(1).max(40).default("Floor 1") });
export const listRooms = createServerFn({ method: "POST" }).validator(z.object({ property: z.string().optional() })).handler(async ({ data }) => {
  const { DB } = bindings(); if (!DB) return { ok: false, rows: [], message: "Database is not enabled." };
  const sql = `SELECT id, property, room, bed_capacity, floor, active FROM rooms WHERE active=1${data.property && data.property !== "All Properties" ? " AND property=?" : ""} ORDER BY property, floor, room LIMIT 1000`;
  const result = data.property && data.property !== "All Properties" ? await DB.prepare(sql).bind(data.property).all<RoomRow>() : await DB.prepare(sql).all<RoomRow>();
  return { ok: true, rows: result.results ?? [] };
});
export const saveRoom = createServerFn({ method: "POST" }).validator(roomInput).handler(async ({ data }) => {
  const { DB } = bindings(); if (!DB) return { ok: false, message: "Database is not enabled." };
  const occupied = await DB.prepare("SELECT COUNT(*) AS n FROM tenants WHERE property=? AND (lower(room)=lower(?) OR lower(room) LIKE lower(?)) AND status!='Vacated'").bind(data.property, data.room, `${data.room} /%`).first<{n:number}>();
  if ((occupied?.n ?? 0) > data.capacity) return { ok: false, message: `This room has ${occupied?.n ?? 0} active tenant records. Reassign tenants before reducing capacity below that number.` };
  try {
    const row = await DB.prepare(`INSERT INTO rooms (property, room, bed_capacity, floor, active, updated_at) VALUES (?, ?, ?, ?, 1, datetime('now')) ON CONFLICT(property, room) DO UPDATE SET bed_capacity=excluded.bed_capacity, floor=excluded.floor, active=1, updated_at=datetime('now') RETURNING id, property, room, bed_capacity, floor, active`).bind(data.property, data.room, data.capacity, data.floor).first<RoomRow>();
    await DB.prepare(`INSERT INTO room_meters (property, room, default_rate, member_names, active, updated_at) VALUES (?, ?, 11, '', 1, datetime('now')) ON CONFLICT(property, room) DO UPDATE SET active=1, updated_at=datetime('now')`).bind(data.property, data.room).run();
    return row ? { ok: true, room: row } : { ok: false, message: "Room could not be saved." };
  } catch (error) { const message = error instanceof Error ? error.message : ""; return { ok: false, message: /unique|constraint/i.test(message) ? "This room could not be saved because a matching room already exists." : "Room could not be saved." }; }
});
export const deleteRoom = createServerFn({ method: "POST" }).validator(z.object({ id: z.number().int().positive() })).handler(async ({ data }) => {
  const { DB } = bindings(); if (!DB) return { ok: false, message: "Database is not enabled." };
  const room = await DB.prepare("SELECT property, room FROM rooms WHERE id=? AND active=1").bind(data.id).first<{property:string;room:string}>();
  if (!room) return { ok: false, message: "Room not found or already removed." };
  const tenants = await DB.prepare("SELECT COUNT(*) AS n FROM tenants WHERE property=? AND (lower(room)=lower(?) OR lower(room) LIKE lower(?)) AND status!='Vacated'").bind(room.property, room.room, `${room.room} /%`).first<{n:number}>();
  if ((tenants?.n ?? 0) > 0) return { ok: false, message: "This room has active tenant records. Reassign or vacate tenants before removing it." };
  const bills = await DB.prepare("SELECT COUNT(*) AS n FROM electricity_bills WHERE property=? AND room=?").bind(room.property, room.room).first<{n:number}>();
  if ((bills?.n ?? 0) > 0) return { ok: false, message: "This room has electricity history. Keep it in inventory to preserve billing records." };
  await DB.batch([DB.prepare("UPDATE rooms SET active=0, updated_at=datetime('now') WHERE id=?").bind(data.id), DB.prepare("UPDATE room_meters SET active=0, updated_at=datetime('now') WHERE property=? AND room=?").bind(room.property, room.room)]);
  return { ok: true };
});
