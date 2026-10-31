import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";

export type MaintenanceRequestRow = {
  id: number; property: string; room: string; tenant_name: string; tenant_phone: string;
  category: string; title: string; description: string; priority: "Low" | "Normal" | "High" | "Urgent";
  status: "Open" | "In Progress" | "Waiting for Parts" | "Resolved" | "Closed";
  assigned_to: string; resolution_note: string; created_at: string; updated_at: string; resolved_at: string | null;
};

const requestInput = z.object({
  property: z.string().trim().min(1).max(180), room: z.string().trim().min(1).max(80),
  tenantName: z.string().trim().min(1).max(120), tenantPhone: z.string().trim().max(30).default(""),
  category: z.enum(["Electrical", "Plumbing", "Cleaning", "Appliance", "Internet", "Security", "General"]),
  title: z.string().trim().min(3).max(160), description: z.string().trim().max(2000).default(""),
  priority: z.enum(["Low", "Normal", "High", "Urgent"]).default("Normal"),
});

export const listMaintenanceRequests = createServerFn({ method: "POST" })
  .validator(z.object({ property: z.string().optional(), status: z.string().optional(), search: z.string().max(120).optional() }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, rows: [] as MaintenanceRequestRow[], message: "Database is not enabled." };
    let sql = "SELECT id,property,room,tenant_name,tenant_phone,category,title,description,priority,status,assigned_to,resolution_note,created_at,updated_at,resolved_at FROM maintenance_requests WHERE 1=1";
    const values: string[] = [];
    if (data.property && data.property !== "All Properties") { sql += " AND property=?"; values.push(data.property); }
    if (data.status && data.status !== "All") { sql += " AND status=?"; values.push(data.status); }
    if (data.search?.trim()) { sql += " AND (room LIKE ? OR tenant_name LIKE ? OR title LIKE ? OR category LIKE ?)"; const q = `%${data.search.trim()}%`; values.push(q, q, q, q); }
    sql += " ORDER BY CASE priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Normal' THEN 2 ELSE 3 END, CASE status WHEN 'Open' THEN 0 WHEN 'In Progress' THEN 1 WHEN 'Waiting for Parts' THEN 2 ELSE 3 END, created_at DESC LIMIT 500";
    const result = await DB.prepare(sql).bind(...values).all<MaintenanceRequestRow>();
    return { ok: true, rows: result.results ?? [] };
  });

export const createMaintenanceRequest = createServerFn({ method: "POST" })
  .validator(requestInput)
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, message: "Database is not enabled." };
    const result = await DB.prepare("INSERT INTO maintenance_requests(property,room,tenant_name,tenant_phone,category,title,description,priority) VALUES(?,?,?,?,?,?,?,?)")
      .bind(data.property, data.room, data.tenantName, data.tenantPhone, data.category, data.title, data.description, data.priority).run();
    return { ok: true, id: Number(result.meta?.last_row_id), message: "Maintenance request created." };
  });

export const updateMaintenanceRequest = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.number().int().positive(), status: z.enum(["Open", "In Progress", "Waiting for Parts", "Resolved", "Closed"]), assignedTo: z.string().trim().max(120).default(""), resolutionNote: z.string().trim().max(2000).default("") }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, message: "Database is not enabled." };
    const row = await DB.prepare("SELECT id FROM maintenance_requests WHERE id=?").bind(data.id).first<{ id: number }>();
    if (!row) return { ok: false, message: "Request not found." };
    await DB.prepare("UPDATE maintenance_requests SET status=?,assigned_to=?,resolution_note=?,updated_at=datetime('now'),resolved_at=CASE WHEN ? IN ('Resolved','Closed') THEN COALESCE(resolved_at,datetime('now')) ELSE NULL END WHERE id=?")
      .bind(data.status, data.assignedTo, data.resolutionNote, data.status, data.id).run();
    return { ok: true, message: "Maintenance request updated." };
  });
