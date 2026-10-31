import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";

type FinanceLedgerRow = {id:number;property:string;tenant_name:string;tenant_phone:string;room:string;billing_period:string;charge_type:string;description:string;amount:number;paid_amount:number;status:string;updated_at:string;due_date:string;invoice_number:string};

const chargeSchema = z.object({ property:z.string().min(1).max(180), tenantName:z.string().min(1).max(120), tenantPhone:z.string().min(1).max(30), room:z.string().max(80).default(""), amount:z.number().nonnegative(), description:z.string().max(1500).optional() });

export const postMonthlyRentDues = createServerFn({method:"POST"})
 .validator(z.object({period:z.string().regex(/^\d{4}-\d{2}$/), dueDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), tenants:z.array(chargeSchema).min(1).max(500)}))
 .handler(async ({data})=>{
  const {DB}=bindings(); if(!DB)return {ok:false,posted:0,skipped:0,message:"Database is not enabled."};
  let posted=0;let skipped=0;const statements=[];
  for(const t of data.tenants){const existing=await DB.prepare("SELECT id FROM tenant_charges WHERE property=? AND tenant_phone=? AND billing_period=? AND charge_type='rent' AND room=? LIMIT 1").bind(t.property,t.tenantPhone,data.period,t.room).first<{id:number}>();if(existing){skipped++;continue}posted++;statements.push(DB.prepare(`INSERT OR IGNORE INTO tenant_charges(property,tenant_name,tenant_phone,room,billing_period,charge_type,description,amount,paid_amount,status,due_date,invoice_number,updated_at)
   VALUES(?,?,?,?,?,'rent','Monthly rent',?,0,CASE WHEN ?=0 THEN 'paid' ELSE 'unpaid' END,?,?,datetime('now'))`)
   .bind(t.property,t.tenantName,t.tenantPhone,t.room,data.period,t.amount,t.amount,data.dueDate??`${data.period}-10`, `WH-${data.period.replace('-','')}-${t.tenantPhone.replace(/\D/g,'').slice(-4)}`));}
  if(statements.length)await DB.batch(statements);return {ok:true,posted,skipped};
 });

export const postElectricityToTenantCharges = createServerFn({method:"POST"})
 .validator(z.object({period:z.string().regex(/^\d{4}-\d{2}$/),allocations:z.array(chargeSchema).min(1).max(500)}))
 .handler(async ({data})=>{
  const {DB}=bindings(); if(!DB)return {ok:false,posted:0,message:"Database is not enabled."};
  const statements=data.allocations.map(t=>DB.prepare(`INSERT INTO tenant_charges(property,tenant_name,tenant_phone,room,billing_period,charge_type,description,amount,paid_amount,status,updated_at)
   VALUES(?,?,?,?,?,'electricity',?, ?,0,CASE WHEN ?=0 THEN 'paid' ELSE 'unpaid' END,datetime('now'))
   ON CONFLICT(property,tenant_phone,billing_period,charge_type,room) DO UPDATE SET tenant_name=excluded.tenant_name, description=excluded.description, amount=excluded.amount, paid_amount=MIN(tenant_charges.paid_amount,excluded.amount), status=CASE WHEN MIN(tenant_charges.paid_amount,excluded.amount)>=excluded.amount THEN 'paid' ELSE 'unpaid' END, updated_at=datetime('now')`)
   .bind(t.property,t.tenantName,t.tenantPhone,t.room,data.period,t.description?.trim()||`Electricity · ${t.room}`,t.amount,t.amount));
  await DB.batch(statements); return {ok:true,posted:data.allocations.length};
 });

export const getTenantFinanceLedger = createServerFn({method:"POST"})
 .validator(z.object({property:z.string().optional(),period:z.string().regex(/^\d{4}-\d{2}$/).optional()}))
 .handler(async ({data})=>{
  const {DB}=bindings(); if(!DB)return {ok:false,rows:[] as FinanceLedgerRow[],message:"Database is not enabled."};
  // Runtime-safe backfill makes sure legacy tenants' deposits appear in Passbook even if an earlier migration was skipped.
  await DB.prepare(`INSERT OR IGNORE INTO tenant_charges(property,tenant_name,tenant_phone,room,billing_period,charge_type,description,amount,paid_amount,status,due_date,invoice_number,updated_at)
    SELECT t.property,t.full_name,t.phone,t.room,substr(COALESCE(t.move_in_date,t.joined_on,date('now')),1,7)||'-DEPOSIT','rent','Security deposit',t.security_deposit,0,'unpaid',COALESCE(t.move_in_date,t.joined_on,date('now')),
    'WH-DEP-'||replace(substr(COALESCE(t.move_in_date,t.joined_on,date('now')),1,7),'-','')||'-'||substr(replace(t.phone,' ',''),-4),datetime('now')
    FROM tenants t WHERE COALESCE(t.security_deposit,0)>0 AND NOT EXISTS(SELECT 1 FROM tenant_charges c WHERE c.property=t.property AND c.tenant_phone=t.phone AND c.description='Security deposit')`).run();
  let sql="SELECT id,property,tenant_name,tenant_phone,room,billing_period,charge_type,description,amount,paid_amount,status,updated_at,due_date,invoice_number FROM tenant_charges WHERE 1=1";const values:string[]=[];
  if(data.property&&data.property!=="All Properties"){sql+=" AND property=?";values.push(data.property)} if(data.period){sql+=" AND billing_period=?";values.push(data.period)}
  sql+=" ORDER BY billing_period DESC,property,tenant_name,charge_type LIMIT 1000";
  const r=await DB.prepare(sql).bind(...values).all<FinanceLedgerRow>();return {ok:true,rows:(r.results??[]) as FinanceLedgerRow[]};
 });

export const recordTenantFinancePayment = createServerFn({method:"POST"})
 .validator(z.object({property:z.string().min(1),tenantName:z.string().min(1),tenantPhone:z.string().min(1),amount:z.number().positive(),method:z.string().max(40).default("Cash"),reference:z.string().max(120).default("")}))
 .handler(async ({data})=>{
  const {DB}=bindings();if(!DB)return {ok:false,applied:0,message:"Database is not enabled."};
  if(data.reference.trim()){const duplicate=await DB.prepare("SELECT id FROM tenant_payments WHERE property=? AND tenant_phone=? AND reference=? LIMIT 1").bind(data.property,data.tenantPhone,data.reference.trim()).first<{id:number}>();if(duplicate)return {ok:false,applied:0,message:`This payment reference has already been recorded (payment #${duplicate.id}). Check collection history before retrying.`};}
  const fromDeposit=data.method==="From security deposit";
  const tenant=await DB.prepare("SELECT id,security_deposit FROM tenants WHERE property=? AND phone=? ORDER BY id DESC LIMIT 1").bind(data.property,data.tenantPhone).first<{id:number;security_deposit:number}>();
  const depositPaid=await DB.prepare("SELECT COALESCE(SUM(paid_amount),0) AS paid FROM tenant_charges WHERE property=? AND tenant_phone=? AND lower(description) LIKE '%security deposit%'").bind(data.property,data.tenantPhone).first<{paid:number}>();
  const availableDeposit=Math.min(tenant?.security_deposit||0,depositPaid?.paid||0);
  if(fromDeposit&&(!tenant||data.amount>availableDeposit+0.001))return {ok:false,applied:0,message:`Amount exceeds available deposit already received (${availableDeposit}). Record the security-deposit payment first if it has been collected.`};
  const found=await DB.prepare(`SELECT id,amount,paid_amount FROM tenant_charges WHERE property=? AND tenant_phone=? AND status!='paid' ${fromDeposit?"AND description!='Security deposit'":""} ORDER BY CASE WHEN description='Security deposit' THEN 1 ELSE 0 END, billing_period ASC, CASE charge_type WHEN 'rent' THEN 0 ELSE 1 END,id ASC`).bind(data.property,data.tenantPhone).all<{id:number;amount:number;paid_amount:number}>();
  let remaining=data.amount;const pending:{chargeId:number;amount:number;oldPaid:number;newPaid:number;chargeAmount:number}[]=[];
  for(const row of found.results??[]){if(remaining<=0.001)break;const balance=Math.max(0,row.amount-row.paid_amount);const part=Math.min(balance,remaining);if(part<=0)continue;pending.push({chargeId:row.id,amount:part,oldPaid:row.paid_amount,newPaid:row.paid_amount+part,chargeAmount:row.amount});remaining-=part;}
  const applied=data.amount-remaining;
  if(applied<=0.001)return {ok:true,applied:0,unallocated:data.amount,message:"No posted outstanding charges were found; no payment was recorded."};
  if(fromDeposit&&applied>availableDeposit+0.001)return {ok:false,applied:0,message:"Insufficient security deposit balance already received."};
  const method=fromDeposit?"Adjusted from security deposit":data.method;
  // Insert the receipt, allocations and balance changes in one D1 transaction.
  // Previously the receipt was committed first and allocations were written in a
  // second batch; a failed second step left a collection-history row with zero
  // allocations and charges that still appeared unpaid.
  const statements=[DB.prepare("INSERT INTO tenant_payments(property,tenant_name,tenant_phone,amount,payment_method,reference,allocated_amount) VALUES(?,?,?,?,?,?,?)")
    .bind(data.property,data.tenantName,data.tenantPhone,applied,method,data.reference.trim(),applied)];
  if(pending.length){
    const allocationValues=pending.map(()=>"SELECT ? AS charge_id, ? AS amount").join(" UNION ALL ");
    const allocationBindings=pending.flatMap(a=>[a.chargeId,a.amount]);
    statements.push(DB.prepare(`INSERT INTO tenant_payment_allocations(payment_id,charge_id,allocated_amount)
      SELECT p.id,v.charge_id,v.amount FROM tenant_payments p
      JOIN (${allocationValues}) v ON p.id=(SELECT MAX(id) FROM tenant_payments)`)
      .bind(...allocationBindings));
  }
  for(const a of pending)statements.push(DB.prepare("UPDATE tenant_charges SET paid_amount=?,status=?,updated_at=datetime('now') WHERE id=?").bind(a.newPaid,a.newPaid>=a.chargeAmount-0.001?"paid":"unpaid",a.chargeId));
  if(fromDeposit&&tenant)statements.push(DB.prepare("UPDATE tenants SET security_deposit=MAX(0,security_deposit-?) WHERE id=?").bind(applied,tenant.id));
  let batchResults:any[];
  try{batchResults=await DB.batch(statements)}catch{return {ok:false,applied:0,message:"Payment was not recorded because its receipt and charge allocations could not be saved together. Refresh before retrying."}}
  const paymentId=Number(batchResults?.[0]?.meta?.last_row_id);
  if(!Number.isFinite(paymentId)||paymentId<=0)return {ok:false,applied:0,message:"Payment transaction did not return a receipt number. Refresh collection history before retrying."};
  return {ok:true,applied,unallocated:remaining,paymentId,allocationCount:pending.length,depositRemaining:fromDeposit?Math.max(0,(tenant?.security_deposit||0)-applied):undefined,method};
 });

export type TenantPaymentRow = {id:number;property:string;tenant_name:string;tenant_phone:string;amount:number;payment_method:string;reference:string;allocated_amount:number;created_at:string;allocation_summary:string|null;allocation_count:number;allocation_total:number};
export const getTenantPaymentHistory = createServerFn({method:"POST"})
 .validator(z.object({property:z.string().optional(),search:z.string().max(120).optional()}))
 .handler(async ({data})=>{
  const {DB}=bindings();if(!DB)return {ok:false,rows:[] as TenantPaymentRow[]};
  let sql="SELECT p.id,p.property,p.tenant_name,p.tenant_phone,p.amount,p.payment_method,p.reference,p.allocated_amount,p.created_at, (SELECT group_concat(COALESCE(NULLIF(c.description,''),c.charge_type || ' ' || c.billing_period) || ' · ' || printf('%.2f',a.allocated_amount), ' | ') FROM tenant_payment_allocations a JOIN tenant_charges c ON c.id=a.charge_id WHERE a.payment_id=p.id) AS allocation_summary, (SELECT COUNT(*) FROM tenant_payment_allocations a WHERE a.payment_id=p.id) AS allocation_count, (SELECT COALESCE(SUM(a.allocated_amount),0) FROM tenant_payment_allocations a WHERE a.payment_id=p.id) AS allocation_total FROM tenant_payments p WHERE 1=1";const values:string[]=[];
  if(data.property&&data.property!=="All Properties"){sql+=" AND p.property=?";values.push(data.property)}
  if(data.search?.trim()){sql+=" AND (p.tenant_name LIKE ? OR p.tenant_phone LIKE ? OR p.reference LIKE ?)";const q=`%${data.search.trim()}%`;values.push(q,q,q)}
  sql+=" ORDER BY p.created_at DESC,p.id DESC LIMIT 500";const result=await DB.prepare(sql).bind(...values).all<TenantPaymentRow>();return {ok:true,rows:(result.results??[]) as TenantPaymentRow[]};
 });


export const updateTenantCharge = createServerFn({method:"POST"})
 .validator(z.object({id:z.number().int().positive(),property:z.string().min(1),tenantPhone:z.string().min(1),amount:z.number().nonnegative().max(10000000),description:z.string().trim().min(1).max(1500),dueDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}))
 .handler(async ({data})=>{
  const {DB}=bindings();if(!DB)return {ok:false,message:"Database is not enabled."};
  const row=await DB.prepare("SELECT id,amount,paid_amount FROM tenant_charges WHERE id=? AND property=? AND tenant_phone=?").bind(data.id,data.property,data.tenantPhone).first<{id:number;amount:number;paid_amount:number}>();
  if(!row)return {ok:false,message:"Charge not found."};if(data.amount<row.paid_amount-0.001)return {ok:false,message:`Amount cannot be less than already paid (${row.paid_amount}).`};
  const status=data.amount<=0.001||row.paid_amount>=data.amount-0.001?"paid":"unpaid";
  await DB.prepare("UPDATE tenant_charges SET amount=?,description=?,due_date=?,status=?,updated_at=datetime('now') WHERE id=?").bind(data.amount,data.description,data.dueDate,status,row.id).run();
  return {ok:true,message:"Charge updated."};
 });

export const deleteTenantCharge = createServerFn({method:"POST"})
 .validator(z.object({id:z.number().int().positive(),property:z.string().min(1),tenantPhone:z.string().min(1)}))
 .handler(async ({data})=>{
  const {DB}=bindings();if(!DB)return {ok:false,message:"Database is not enabled."};
  const row=await DB.prepare("SELECT c.id,c.paid_amount,(SELECT COUNT(*) FROM tenant_payment_allocations a WHERE a.charge_id=c.id) AS allocations FROM tenant_charges c WHERE c.id=? AND c.property=? AND c.tenant_phone=?").bind(data.id,data.property,data.tenantPhone).first<{id:number;paid_amount:number;allocations:number}>();
  if(!row)return {ok:false,message:"Charge not found."};if(row.paid_amount>0.001||row.allocations>0)return {ok:false,message:"This charge has payment history. Edit it to correct the amount, or record a refund; it cannot be deleted safely."};
  await DB.prepare("DELETE FROM tenant_charges WHERE id=?").bind(row.id).run();return {ok:true,message:"Charge removed."};
 });

export type FinanceAdjustmentRow = {id:number;property:string;tenant_name:string;tenant_phone:string;charge_id:number|null;action:string;amount:number;old_amount:number;new_amount:number;old_paid_amount:number;new_paid_amount:number;reason:string;created_at:string};
export const applyFinanceAdjustment = createServerFn({method:"POST"})
 .validator(z.object({property:z.string().min(1).max(180),tenantName:z.string().min(1).max(120),tenantPhone:z.string().min(1).max(30),action:z.enum(["charge_adjustment","refund"]),chargeId:z.number().int().positive().optional(),amount:z.number().positive().max(10000000),reason:z.string().trim().min(5).max(500)}))
 .handler(async ({data})=>{
  const {DB}=bindings();if(!DB)return {ok:false,message:"Database is not enabled."};
  if(data.action==="charge_adjustment"){
   if(!data.chargeId)return {ok:false,message:"Select a charge to adjust."};
   const row=await DB.prepare("SELECT id,property,tenant_name,tenant_phone,amount,paid_amount FROM tenant_charges WHERE id=? AND property=? AND tenant_phone=? LIMIT 1").bind(data.chargeId,data.property,data.tenantPhone).first<{id:number;property:string;tenant_name:string;tenant_phone:string;amount:number;paid_amount:number}>();
   if(!row)return {ok:false,message:"Charge not found for this tenant/property."};
   const newAmount=row.amount+data.amount;
   if(newAmount<row.paid_amount-0.001)return {ok:false,message:"The corrected charge cannot be lower than the amount already paid. Record a refund for money returned to the tenant."};
   const status=newAmount<=0.001?"paid":row.paid_amount>=newAmount-0.001?"paid":"unpaid";
   await DB.batch([
    DB.prepare("UPDATE tenant_charges SET amount=?,status=?,updated_at=datetime('now') WHERE id=?").bind(newAmount,status,row.id),
    DB.prepare("INSERT INTO finance_adjustments(property,tenant_name,tenant_phone,charge_id,action,amount,old_amount,new_amount,old_paid_amount,new_paid_amount,reason) VALUES(?,?,?,?, 'charge_adjustment',?,?,?,?,?,?)").bind(row.property,row.tenant_name,row.tenant_phone,row.id,data.amount,row.amount,newAmount,row.paid_amount,row.paid_amount,data.reason)
   ]);
   return {ok:true,adjusted:1,message:`Charge adjusted from ${row.amount} to ${newAmount}.`};
  }
  const rows=await DB.prepare("SELECT id,amount,paid_amount FROM tenant_charges WHERE property=? AND tenant_phone=? AND paid_amount>0 ORDER BY billing_period DESC, id DESC").bind(data.property,data.tenantPhone).all<{id:number;amount:number;paid_amount:number}>();
  const totalPaid=(rows.results??[]).reduce((sum,r)=>sum+r.paid_amount,0);
  if(data.amount>totalPaid+0.001)return {ok:false,message:`Refund exceeds the tenant's recorded allocated payments (${totalPaid}).`};
  let remaining=data.amount;const statements=[];
  for(const row of rows.results??[]){if(remaining<=0.001)break;const part=Math.min(row.paid_amount,remaining);if(part<=0)continue;const newPaid=row.paid_amount-part;statements.push(DB.prepare("UPDATE tenant_charges SET paid_amount=?,status=?,updated_at=datetime('now') WHERE id=?").bind(newPaid,newPaid>=row.amount-0.001?"paid":"unpaid",row.id));statements.push(DB.prepare("INSERT INTO finance_adjustments(property,tenant_name,tenant_phone,charge_id,action,amount,old_amount,new_amount,old_paid_amount,new_paid_amount,reason) VALUES(?,?,?,?, 'refund',?,?,?,?,?,?)").bind(data.property,data.tenantName,data.tenantPhone,row.id,part,row.amount,row.amount,row.paid_amount,newPaid,data.reason));remaining-=part;}
  if(statements.length)await DB.batch(statements);
  return {ok:true,adjusted:statements.length/2,message:`Refund recorded: ${data.amount}. Outstanding balances were recalculated.`};
 });

export const getFinanceAdjustments = createServerFn({method:"POST"})
 .validator(z.object({property:z.string().optional(),search:z.string().max(120).optional()}))
 .handler(async ({data})=>{
  const {DB}=bindings();if(!DB)return {ok:false,rows:[] as FinanceAdjustmentRow[]};
  let sql="SELECT id,property,tenant_name,tenant_phone,charge_id,action,amount,old_amount,new_amount,old_paid_amount,new_paid_amount,reason,created_at FROM finance_adjustments WHERE 1=1";const values:string[]=[];
  if(data.property&&data.property!=="All Properties"){sql+=" AND property=?";values.push(data.property)}
  if(data.search?.trim()){sql+=" AND (tenant_name LIKE ? OR tenant_phone LIKE ? OR reason LIKE ?)";const q=`%${data.search.trim()}%`;values.push(q,q,q)}
  sql+=" ORDER BY created_at DESC,id DESC LIMIT 500";const result=await DB.prepare(sql).bind(...values).all<FinanceAdjustmentRow>();return {ok:true,rows:(result.results??[]) as FinanceAdjustmentRow[]};
 });
