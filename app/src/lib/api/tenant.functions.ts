import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";

type TenantRow = { id: number; property: string; full_name: string; phone: string; room: string; monthly_rent: number; security_deposit: number; rent_cycle: string; status: string; kyc_status: string; autopay: number; joined_on: string; move_out_date?: string | null; move_in_date?: string | null; notice_period_days?: number; move_out_charge?: number; onboarding_status?: string };

async function managerSession(DB:any, token:string) {
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(token),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:new TextEncoder().encode("wink-session-v1"),iterations:100000,hash:"SHA-256"},key,256);
  const hash=Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,"0")).join("");
  return DB.prepare("SELECT a.phone,a.name,a.role FROM manager_pin_sessions s JOIN manager_pin_accounts a ON a.phone=s.phone WHERE s.token_hash=? AND s.expires_at>datetime('now') AND a.must_change_pin=0").bind(hash).first() as {phone:string;name:string;role:string}|null;
}

const tenantInput = z.object({
  property: z.string().trim().min(1).max(180),
  name: z.string().trim().min(1).max(120),
  phone: z.preprocess((value)=>{if(typeof value!=="string")return value;let digits=value.replace(/\D/g,"");if(digits.length===12&&digits.startsWith("91"))digits=digits.slice(2);return digits;},z.string().regex(/^[6-9]\d{9}$/,"Enter a valid 10-digit Indian mobile number.")),
  room: z.string().trim().min(1).max(80),
  rent: z.number().nonnegative().max(10000000),
  deposit: z.number().nonnegative().max(10000000),
  rentCycle: z.string().max(80).default("1st of every month"),
  moveInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  noticePeriodDays: z.number().int().min(0).max(90).default(30),
  firstMonthCharge: z.number().nonnegative().max(10000000).optional(),
  prorated: z.boolean().default(false),
});

export const listTenants = createServerFn({ method: "POST" })
  .validator(z.object({ property: z.string().optional() }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, rows: [], message: "Database is not enabled for this deployment." };
    // Promote future bookings to occupied on their move-in date and process scheduled move-outs.
    const arriving = await DB.prepare("SELECT id,property,full_name,phone,room,monthly_rent,move_in_date FROM tenants WHERE status='Booked' AND move_in_date IS NOT NULL AND date(move_in_date)<=date('now','+5 hours','+30 minutes')").all<{id:number;property:string;full_name:string;phone:string;room:string;monthly_rent:number;move_in_date:string}>();
    for (const t of arriving.results ?? []) {
      const period=t.move_in_date.slice(0,7);
      const day=Number(t.move_in_date.slice(8,10));
      const daysInMonth=Number(await DB.prepare("SELECT CAST(strftime('%d',date(?,'start of month','+1 month','-1 day')) AS INTEGER) AS days").bind(t.move_in_date).first<{days:number}>().then(r=>r?.days||30));
      const amount=Math.round(Number(t.monthly_rent)*Math.max(0,daysInMonth-day+1)/Math.max(1,daysInMonth));
      await DB.prepare("INSERT OR IGNORE INTO tenant_charges(property,tenant_name,tenant_phone,room,billing_period,charge_type,description,amount,paid_amount,status,due_date,invoice_number,updated_at) VALUES(?,?,?,?,?,'rent','Prorated first-month rent',?,0,CASE WHEN ?=0 THEN 'paid' ELSE 'unpaid' END,?,?,datetime('now'))").bind(t.property,t.full_name,t.phone,t.room,period,amount,amount,`${period}-10`,`WH-${period.replace('-','')}-${t.phone.replace(/\D/g,'').slice(-4)}`).run();
    }
    await DB.prepare("UPDATE tenants SET status='Occupied', updated_at=datetime('now') WHERE status='Booked' AND move_in_date IS NOT NULL AND date(move_in_date)<=date('now','+5 hours','+30 minutes')").run();
    const dueMoves = await DB.prepare("SELECT id, property, full_name, phone, status, security_deposit, move_out_date, move_out_charge FROM tenants WHERE status='Under Notice' AND move_out_date IS NOT NULL AND date(move_out_date)<=date('now','+5 hours','+30 minutes')").all<{id:number;property:string;full_name:string;phone:string;status:string;security_deposit:number;move_out_date:string;move_out_charge:number}>();
    for (const t of dueMoves.results ?? []) {
      await DB.prepare("INSERT INTO tenant_lifecycle_history (tenant_id,property,tenant_name,phone,previous_status,new_status,reason) VALUES (?,?,?,?,?,?,?)").bind(t.id,t.property,t.full_name,t.phone,t.status,"Vacated","Automatic move-out on scheduled date").run();
      const dues = await DB.prepare("SELECT COALESCE(SUM(MAX(amount-paid_amount,0)),0) AS pending FROM tenant_charges WHERE property=? AND tenant_phone=?").bind(t.property,t.phone).first<{pending:number}>();
      const pending=Number(dues?.pending||0),deposit=Number(t.security_deposit||0),charge=Number(t.move_out_charge??500),deductions=Math.min(deposit,pending+charge),refund=Math.max(0,deposit-pending-charge),additionalDue=Math.max(0,pending+charge-deposit);
      await DB.prepare("INSERT INTO tenant_moveout_settlements(tenant_id,property,tenant_name,phone,move_out_date,security_deposit,pending_dues,move_out_charge,deposit_deductions,refund_amount,additional_due) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(t.id,t.property,t.full_name,t.phone,t.move_out_date,deposit,pending,charge,deductions,refund,additionalDue).run();
      await DB.prepare("UPDATE tenants SET status='Vacated', updated_at=datetime('now') WHERE id=?").bind(t.id).run();
      await DB.prepare("UPDATE room_meters SET member_names=COALESCE((SELECT group_concat(x.full_name, ', ') FROM tenants x WHERE x.property=room_meters.property AND (lower(x.room)=lower(room_meters.room) OR lower(x.room) LIKE lower(room_meters.room || ' /%')) AND x.status!='Vacated'), ''), updated_at=datetime('now') WHERE property=? AND active=1").bind(t.property).run();
    }
    let sql = "SELECT t.id, t.property, t.full_name, t.phone, t.room, t.monthly_rent, t.security_deposit, t.rent_cycle, t.status, t.kyc_status, t.autopay, t.joined_on, t.move_out_date, t.move_in_date, t.notice_period_days, t.move_out_charge, CASE WHEN EXISTS (SELECT 1 FROM tenant_onboarding_profiles op WHERE op.tenant_id=t.id AND op.submitted_at IS NOT NULL) THEN 'Submitted' ELSE 'Incomplete' END AS onboarding_status FROM tenants t";
    const values: string[] = [];
    if (data.property && data.property !== "All Properties") { sql += " WHERE t.property = ?"; values.push(data.property); }
    sql += " ORDER BY created_at DESC, id DESC LIMIT 500";
    const result = await DB.prepare(sql).bind(...values).all<TenantRow>();
    const sourceRows = result.results ?? [];
    const ids = sourceRows.map(row=>row.id);
    const [configs,profiles,documents] = ids.length ? await Promise.all([
      DB.prepare("SELECT property,mandatory_fields_json,mandatory_documents_json FROM property_onboarding_configs").all<any>(),
      DB.prepare(`SELECT tenant_id,blood_group,guardian_name,guardian_phone,occupation,permanent_address,emergency_contact_name,emergency_contact_phone,submitted_at FROM tenant_onboarding_profiles WHERE tenant_id IN (${ids.map(()=>"?").join(",")})`).bind(...ids).all<any>(),
      DB.prepare(`SELECT tenant_id,document_type FROM tenant_kyc_documents WHERE is_current=1 AND review_status!='Rejected' AND tenant_id IN (${ids.map(()=>"?").join(",")})`).bind(...ids).all<any>()
    ]) : [{results:[]},{results:[]},{results:[]}];
    const configByProperty=new Map((configs.results||[]).map((row:any)=>{try{return [row.property,{fields:JSON.parse(row.mandatory_fields_json),documents:JSON.parse(row.mandatory_documents_json)}] as const}catch{return [row.property,{fields:["permanent_address","emergency_contact_name","emergency_contact_phone","profile_photo","aadhaar"],documents:["aadhaar"]}] as const}}));
    const profileByTenant=new Map((profiles.results||[]).map((row:any)=>[row.tenant_id,row]));
    const docsByTenant=new Map<number,Set<string>>();
    for(const doc of documents.results||[]){if(!docsByTenant.has(doc.tenant_id))docsByTenant.set(doc.tenant_id,new Set());docsByTenant.get(doc.tenant_id)!.add(doc.document_type)}
    const docFields=["profile_photo","aadhaar","company_college_id"];
    return { ok: true, rows: sourceRows.map(row => {
      const profile:any=profileByTenant.get(row.id);const config:any=configByProperty.get(row.property)||{fields:["permanent_address","emergency_contact_name","emergency_contact_phone","profile_photo","aadhaar"],documents:["aadhaar"]};const docs=docsByTenant.get(row.id)||new Set<string>();
      const fieldsComplete=config.fields.every((key:string)=>docFields.includes(key)?docs.has(key):!!String(profile?.[key]||"").trim());
      const docsComplete=config.documents.every((key:string)=>docs.has(key));
      const onboardingStatus=profile?.submitted_at&&fieldsComplete&&docsComplete?"Submitted":"Incomplete";
      return {...row,rentCycle:row.rent_cycle||"1st of every month",id:row.id+100000,due:row.monthly_rent,rent:row.monthly_rent,name:row.full_name,kyc:row.kyc_status,joined:row.joined_on,deposit:row.security_deposit??0,moveOutDate:row.move_out_date??null,moveInDate:row.move_in_date??null,noticePeriodDays:row.notice_period_days??30,onboardingStatus,autopay:Boolean(row.autopay)};
    }) };
  });

export const createTenant = createServerFn({ method: "POST" })
  .validator(tenantInput)
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, message: "Database is not enabled for this deployment." };

    // Resolve a room to a free bed on the server so the browser never chooses a bed
    // and stale UI availability cannot silently overbook a room.
    const room = await DB.prepare("SELECT bed_capacity FROM rooms WHERE property=? AND lower(room)=lower(?) AND active=1")
      .bind(data.property, data.room).first<{ bed_capacity: number }>();
    if (!room) return { ok: false, message: "That room is no longer available. Refresh room inventory and try again." };

    const occupied = await DB.prepare("SELECT phone, room FROM tenants WHERE property=? AND status NOT IN ('Vacated','Left') AND (lower(room)=lower(?) OR lower(room) LIKE lower(?))")
      .bind(data.property, data.room, `${data.room} /%`).all<{ phone: string; room: string }>();
    const otherOccupants = (occupied.results ?? []).filter(t => t.phone !== data.phone);
    if (otherOccupants.length >= room.bed_capacity) {
      return { ok: false, message: "This room is full. Choose another room with a free bed." };
    }

    const usedBeds = new Set<string>();
    for (const tenant of otherOccupants) {
      const match = tenant.room.match(/\/\s*bed\s+([a-z]+)\s*$/i);
      if (match) usedBeds.add(match[1].toUpperCase());
    }
    let bed = "";
    for (let i = 0; i < room.bed_capacity; i++) {
      const candidate = String.fromCharCode(65 + i);
      if (!usedBeds.has(candidate)) { bed = candidate; break; }
    }
    if (!bed) return { ok: false, message: "No free bed remains in this room. Choose another room." };
    const assignedRoom = `${data.room} / Bed ${bed}`;

    const dateResult = data.moveInDate ? await DB.prepare("SELECT date(?) AS move_date,date('now','+5 hours','+30 minutes') AS today").bind(data.moveInDate).first<{move_date:string|null;today:string}>() : null;
    if (data.moveInDate && !dateResult?.move_date) return { ok:false, message:"Enter a valid move-in date." };
    const tenantStatus = data.moveInDate && dateResult?.move_date && dateResult.move_date > dateResult.today ? "Booked" : "Occupied";
    const result = await DB.prepare(
      `INSERT INTO tenants (property, full_name, phone, room, monthly_rent, security_deposit, rent_cycle, status, kyc_status, autopay, move_in_date, notice_period_days, joined_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 0, ?, ?, COALESCE(?,date('now')))
       ON CONFLICT(property, phone) DO UPDATE SET full_name=excluded.full_name, room=excluded.room,
       monthly_rent=excluded.monthly_rent, security_deposit=excluded.security_deposit, rent_cycle=excluded.rent_cycle,
       status=excluded.status, move_in_date=excluded.move_in_date, notice_period_days=excluded.notice_period_days, joined_on=excluded.joined_on, updated_at=datetime('now')
       RETURNING id, property, full_name, phone, room, monthly_rent, security_deposit, rent_cycle, status, kyc_status, autopay, joined_on, move_in_date, notice_period_days`
    ).bind(data.property, data.name, data.phone, assignedRoom, data.rent, data.deposit, data.rentCycle, tenantStatus, data.moveInDate ?? null, data.noticePeriodDays, data.moveInDate ?? null).first<TenantRow>();
    if (!result) return { ok: false, message: "Tenant could not be saved." };
    {
      const period = (data.moveInDate || new Date().toISOString().slice(0,10)).slice(0,7);
      if (Number(data.deposit) > 0) {
        await DB.prepare(`INSERT OR IGNORE INTO tenant_charges(property,tenant_name,tenant_phone,room,billing_period,charge_type,description,amount,paid_amount,status,due_date,invoice_number,updated_at)
          VALUES(?,?,?,?,?,'rent','Security deposit',?,0,'unpaid',?,?,datetime('now'))`)
          .bind(data.property,data.name,data.phone,assignedRoom,`${period}-DEPOSIT`,Number(data.deposit),data.moveInDate ?? `${period}-10`,`WH-DEP-${period.replace('-','')}-${data.phone.replace(/\D/g,'').slice(-4)}`).run();
      }
    }
    if (tenantStatus === "Occupied") {
      const period = (data.moveInDate || new Date().toISOString().slice(0,10)).slice(0,7);
      const firstCharge = data.firstMonthCharge ?? data.rent;
      const desc = data.prorated ? "Prorated first-month rent" : "First-month rent";
      await DB.prepare(`INSERT OR IGNORE INTO tenant_charges(property,tenant_name,tenant_phone,room,billing_period,charge_type,description,amount,paid_amount,status,due_date,invoice_number,updated_at)
        VALUES(?,?,?,?,?,'rent',?,?,0,CASE WHEN ?=0 THEN 'paid' ELSE 'unpaid' END,?,?,datetime('now'))`)
        .bind(data.property,data.name,data.phone,assignedRoom,period,desc,firstCharge,firstCharge,`${period}-10`,`WH-${period.replace('-','')}-${data.phone.replace(/\D/g,'').slice(-4)}`).run();
    }
    await DB.prepare(`UPDATE room_meters SET member_names = COALESCE((SELECT group_concat(t.full_name, ', ') FROM tenants t WHERE t.property=room_meters.property AND (lower(t.room)=lower(room_meters.room) OR lower(t.room) LIKE lower(room_meters.room || ' /%')) AND t.status!='Vacated'), ''), updated_at=datetime('now') WHERE property=? AND active=1`).bind(data.property).run();
    return { ok: true, tenant: { ...result, id: result.id + 100000, rentCycle: result.rent_cycle || data.rentCycle, due: result.monthly_rent, rent: result.monthly_rent, deposit: result.security_deposit, name: result.full_name, kyc: result.kyc_status, joined: result.joined_on, moveInDate: result.move_in_date ?? null, noticePeriodDays: result.notice_period_days ?? 30, autopay: Boolean(result.autopay) } };
  });


const tenantActionInput = z.object({ id: z.number().int().positive(), status: z.enum(["Occupied", "Under Notice", "Vacated"]), reason: z.string().trim().max(500).default(""), moveOutCharge: z.number().nonnegative().max(100000).default(500), moveOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export const updateTenantStatus = createServerFn({ method: "POST" })
  .validator(tenantActionInput)
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB) return { ok: false, message: "Database is not enabled for this deployment." };
    const id = data.id >= 100000 ? data.id - 100000 : data.id;
    const tenant = await DB.prepare("SELECT id, property, full_name, phone, room, status, kyc_status, security_deposit FROM tenants WHERE id=?").bind(id).first<TenantRow & {security_deposit:number}>();
    if (!tenant) return { ok: false, message: "Tenant record was not found." };
    let nextStatus = data.status;
    let moveOutDate: string | null = null;
    if (data.status === "Vacated") {
      if (!data.moveOutDate) return { ok: false, message: "Select the tenant's move-out date." };
      const dateCheck = await DB.prepare("SELECT date(?) AS valid_date, date('now') AS today").bind(data.moveOutDate).first<{valid_date:string|null;today:string}>();
      if (!dateCheck?.valid_date) return { ok: false, message: "Enter a valid move-out date." };
      moveOutDate = data.moveOutDate;
      if (data.moveOutDate > dateCheck.today) nextStatus = "Under Notice";
    } else if (data.status === "Under Notice") {
      moveOutDate = data.moveOutDate ?? null;
    }
    if (tenant.status === nextStatus && (data.status !== "Vacated" || moveOutDate === null)) return { ok: true, status: tenant.status, message: "Tenant already has this status." };
    const actionReason = moveOutDate ? `${data.reason}${data.reason ? " · " : ""}Scheduled move-out: ${moveOutDate}` : data.reason;
    await DB.prepare("INSERT INTO tenant_lifecycle_history (tenant_id,property,tenant_name,phone,previous_status,new_status,reason) VALUES (?,?,?,?,?,?,?)")
      .bind(id, tenant.property, tenant.full_name, tenant.phone, tenant.status, nextStatus, actionReason).run();
    let settlement: {deposit:number;pending:number;charge:number;refund:number;additionalDue:number}|null=null;
    if (nextStatus === "Vacated" && moveOutDate) {
      const existingSettlement=await DB.prepare("SELECT id FROM tenant_moveout_settlements WHERE tenant_id=? AND move_out_date=? LIMIT 1").bind(id,moveOutDate).first<{id:number}>();
      if(!existingSettlement){const dues=await DB.prepare("SELECT COALESCE(SUM(MAX(amount-paid_amount,0)),0) AS pending FROM tenant_charges WHERE property=? AND tenant_phone=?").bind(tenant.property,tenant.phone).first<{pending:number}>();const deposit=Number(tenant.security_deposit||0),pending=Number(dues?.pending||0),charge=data.moveOutCharge,deductions=Math.min(deposit,pending+charge),refund=Math.max(0,deposit-pending-charge),additionalDue=Math.max(0,pending+charge-deposit);await DB.prepare("INSERT INTO tenant_moveout_settlements(tenant_id,property,tenant_name,phone,move_out_date,security_deposit,pending_dues,move_out_charge,deposit_deductions,refund_amount,additional_due) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(id,tenant.property,tenant.full_name,tenant.phone,moveOutDate,deposit,pending,charge,deductions,refund,additionalDue).run();settlement={deposit,pending,charge,refund,additionalDue};}
    }
    await DB.prepare("UPDATE tenants SET status=?, move_out_date=?, move_out_charge=?, updated_at=datetime('now') WHERE id=?").bind(nextStatus, moveOutDate, data.moveOutCharge, id).run();
    await DB.prepare("UPDATE room_meters SET member_names=COALESCE((SELECT group_concat(t.full_name, ', ') FROM tenants t WHERE t.property=room_meters.property AND (lower(t.room)=lower(room_meters.room) OR lower(t.room) LIKE lower(room_meters.room || ' /%')) AND t.status!='Vacated'), ''), updated_at=datetime('now') WHERE property=? AND active=1").bind(tenant.property).run();
    return { ok: true, status: nextStatus, moveOutDate, settlement, message: nextStatus === "Vacated" ? `Tenant moved out on ${moveOutDate}. Historical record retained.` : moveOutDate ? `Move-out scheduled for ${moveOutDate}. Tenant remains active until that date.` : `Tenant status updated to ${nextStatus}.` };
  });

export const getTenantHistory = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().min(20).max(128), id: z.number().int().positive() }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB || !await managerSession(DB,data.token)) return { ok: false, kyc: [], lifecycle: [] };
    const id = data.id >= 100000 ? data.id - 100000 : data.id;
    const [kyc, lifecycle] = await Promise.all([
      DB.prepare("SELECT id, kyc_status, note, recorded_at FROM tenant_kyc_history WHERE tenant_id=? ORDER BY recorded_at DESC,id DESC LIMIT 100").bind(id).all<{id:number;kyc_status:string;note:string;recorded_at:string}>(),
      DB.prepare("SELECT id, previous_status, new_status, reason, changed_at FROM tenant_lifecycle_history WHERE tenant_id=? ORDER BY changed_at DESC,id DESC LIMIT 100").bind(id).all<{id:number;previous_status:string|null;new_status:string;reason:string;changed_at:string}>(),
    ]);
    return { ok: true, kyc: (kyc.results ?? []).map(row=>({id:row.id,kyc_status:row.kyc_status,note:row.note,recorded_at:row.recorded_at})), lifecycle: (lifecycle.results ?? []).map(row=>({id:row.id,previous_status:row.previous_status,new_status:row.new_status,reason:row.reason,changed_at:row.changed_at})) };
  });

export const recordTenantKycStatus = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().min(20).max(128), id: z.number().int().positive(), status: z.enum(["Pending", "Submitted", "Verified", "Rejected", "Expired"]), note: z.string().trim().max(500).default("") }))
  .handler(async ({ data }) => {
    const { DB } = bindings();
    if (!DB || !await managerSession(DB,data.token)) return { ok: false, message: "Please sign in again." };
    const id = data.id >= 100000 ? data.id - 100000 : data.id;
    const tenant = await DB.prepare("SELECT id,property,full_name,kyc_status FROM tenants WHERE id=?").bind(id).first<{id:number;property:string;full_name:string;kyc_status:string}>();
    if (!tenant) return { ok: false, message: "Tenant record was not found." };
    if (data.status === "Verified") {
      const cfgRow=await DB.prepare("SELECT mandatory_fields_json,mandatory_documents_json FROM property_onboarding_configs WHERE property=?").bind(tenant.property).first<any>();
      let requiredFields:string[]=["permanent_address","emergency_contact_name","emergency_contact_phone","profile_photo","aadhaar"],requiredDocs:string[]=["aadhaar"];
      try{if(cfgRow){requiredFields=JSON.parse(cfgRow.mandatory_fields_json);requiredDocs=JSON.parse(cfgRow.mandatory_documents_json)}}catch{}
      const profile=await DB.prepare("SELECT * FROM tenant_onboarding_profiles WHERE tenant_id=?").bind(id).first<any>();
      const values:Record<string,string>={permanent_address:profile?.permanent_address||"",emergency_contact_name:profile?.emergency_contact_name||"",emergency_contact_phone:profile?.emergency_contact_phone||"",blood_group:profile?.blood_group||"",guardian_name:profile?.guardian_name||"",guardian_phone:profile?.guardian_phone||"",occupation:profile?.occupation||""};
      for(const key of requiredFields){
        if(key==="profile_photo"||key==="aadhaar"||key==="company_college_id")continue;
        if(!String(values[key]||"").trim())return{ok:false,message:`Required onboarding detail is missing: ${key.replaceAll("_"," ")}.`};
      }
      if(!profile?.submitted_at)return{ok:false,message:"Tenant onboarding has not been submitted yet."};
      const allDocs=[...new Set([...requiredDocs,...requiredFields.filter(x=>["aadhaar","company_college_id"].includes(x))])];
      for(const type of allDocs){const doc=await DB.prepare("SELECT id FROM tenant_kyc_documents WHERE tenant_id=? AND document_type=? AND is_current=1 AND review_status='Approved' LIMIT 1").bind(id,type).first();if(!doc)return{ok:false,message:`The required ${type.replaceAll("_"," ")} document must be approved before verification.`};}
      if(requiredFields.includes("profile_photo")){const photo=await DB.prepare("SELECT id FROM tenant_kyc_documents WHERE tenant_id=? AND document_type='profile_photo' AND is_current=1 AND review_status='Approved' LIMIT 1").bind(id).first();if(!photo)return{ok:false,message:"The profile photo must be approved before verifying KYC."};}
    }
    await DB.prepare("INSERT INTO tenant_kyc_history (tenant_id,property,tenant_name,kyc_status,note) VALUES (?,?,?,?,?)").bind(id,tenant.property,tenant.full_name,data.status,data.note).run();
    await DB.prepare("UPDATE tenants SET kyc_status=?,updated_at=datetime('now') WHERE id=?").bind(data.status,id).run();
    return { ok: true, status: data.status, message: "KYC status saved to the tenant's history." };
  });

export const permanentlyDeleteTenant = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.number().int().positive(), confirmation: z.literal("DELETE") }))
  .handler(async ({ data }) => {
    const { DB, STORAGE } = bindings();
    if (!DB) return { ok: false, message: "Database is not enabled for this deployment." };
    const id = data.id >= 100000 ? data.id - 100000 : data.id;
    const tenant = await DB.prepare("SELECT id,property FROM tenants WHERE id=?").bind(id).first<{id:number;property:string}>();
    if (!tenant) return { ok: false, message: "Tenant record was not found. Refresh the tenant list and try again." };
    try {
      if (STORAGE) { const files = await DB.prepare("SELECT object_key FROM tenant_kyc_documents WHERE tenant_id=? UNION SELECT object_key FROM tenant_profile_photos WHERE tenant_id=?").bind(id,id).all<{object_key:string}>(); for (const file of files.results ?? []) await STORAGE.delete(file.object_key); }
      await DB.batch([
        DB.prepare("DELETE FROM tenant_portal_sessions WHERE tenant_id=?").bind(id),
        DB.prepare("DELETE FROM tenant_portal_accounts WHERE tenant_id=?").bind(id),
        DB.prepare("DELETE FROM tenant_moveout_requests WHERE tenant_id=?").bind(id),
        DB.prepare("DELETE FROM tenant_kyc_documents WHERE tenant_id=?").bind(id),
        DB.prepare("DELETE FROM tenant_profile_photos WHERE tenant_id=?").bind(id),
        DB.prepare("DELETE FROM tenant_onboarding_profiles WHERE tenant_id=?").bind(id),
        DB.prepare("DELETE FROM tenant_kyc_history WHERE tenant_id=?").bind(id),
        DB.prepare("DELETE FROM tenant_lifecycle_history WHERE tenant_id=?").bind(id),
        DB.prepare("DELETE FROM tenants WHERE id=?").bind(id),
      ]);
      await DB.prepare("UPDATE room_meters SET member_names=COALESCE((SELECT group_concat(t.full_name, ', ') FROM tenants t WHERE t.property=room_meters.property AND (lower(t.room)=lower(room_meters.room) OR lower(t.room) LIKE lower(room_meters.room || ' /%')) AND t.status!='Vacated'), ''), updated_at=datetime('now') WHERE property=? AND active=1").bind(tenant.property).run();
      return { ok: true, message: "Tenant profile, portal access and KYC files were deleted. Financial ledger history is retained for accounting." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? `Tenant could not be deleted: ${error.message}` : "Tenant could not be deleted. Please retry." };
    }
  });
