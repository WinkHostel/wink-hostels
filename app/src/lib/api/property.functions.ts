import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";

type PropertyRow = { id: number; name: string; address: string; status: string };
export const listProperties = createServerFn({ method: "POST" })
  .validator(z.object({}))
  .handler(async () => {
    const { DB } = bindings();
    if (!DB) return { ok: false, rows: [], message: "Database is not enabled." };
    const result = await DB.prepare("SELECT id, name, address, status FROM properties ORDER BY id ASC LIMIT 500").all<PropertyRow>();
    return { ok: true, rows: result.results ?? [] };
  });
export const createProperty = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().trim().min(2).max(180), address: z.string().trim().max(300).default("") }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, message: "Database is not enabled." };
    const exists = await DB.prepare("SELECT id FROM properties WHERE lower(name)=lower(?) LIMIT 1").bind(data.name).first<{id:number}>();
    if (exists) return { ok: false, message: "A property with this name already exists." };
    const result = await DB.prepare("INSERT INTO properties (name, address) VALUES (?, ?) RETURNING id, name, address, status").bind(data.name, data.address).first<PropertyRow>();
    return result ? { ok: true, property: result } : { ok: false, message: "Property could not be saved." };
  });
