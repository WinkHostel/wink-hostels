import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";
import { sessionTenantForPayments } from "./tenant-portal.server";

async function managerSession(DB:any, token:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(token),"PBKDF2",false,["deriveBits"]);const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:new TextEncoder().encode("wink-session-v1"),iterations:100000,hash:"SHA-256"},key,256);const hash=Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,"0")).join("");return DB.prepare("SELECT a.phone,a.role FROM manager_pin_sessions s JOIN manager_pin_accounts a ON a.phone=s.phone WHERE s.token_hash=? AND s.expires_at>datetime('now') AND a.must_change_pin=0").bind(hash).first();}

type PendingUpiRow = { id:number; property:string; tenant_id:number; tenant_name:string; tenant_phone:string; amount:number; upi_reference:string; status:string; admin_note:string; submitted_at:string };

export const submitTenantUpiPayment = createServerFn({method:"POST"})
 .validator(z.object({token:z.string().min(1).max(128),amount:z.number().positive().max(10000000),reference:z.string().trim().min(6).max(80)}))
 .handler(async ({data})=>{
  const {DB}=bindings();if(!DB)return {ok:false,message:"Payment submission is unavailable."};
  const tenant=await sessionTenantForPayments(data.token);if(!tenant)return {ok:false,message:"Your session has expired. Please sign in again."};
  const due=await DB.prepare("SELECT COALESCE(SUM(MAX(0,amount-paid_amount)),0) AS balance FROM tenant_charges WHERE property=? AND tenant_phone=? AND amount>paid_amount").bind(tenant.property,tenant.phone).first<{balance:number}>();
  const balance=Number(due?.balance||0);if(balance<=0)return {ok:false,message:"There are no outstanding charges on your account."};
  if(data.amount>balance+0.001)return {ok:false,message:`Submitted amount cannot exceed your outstanding balance of ₹${Math.round(balance).toLocaleString("en-IN")}.`};
  const existing=await DB.prepare("SELECT id FROM tenant_upi_payment_requests WHERE property=? AND tenant_phone=? AND upi_reference=? LIMIT 1").bind(tenant.property,tenant.phone,data.reference).first<{id:number}>();
  if(existing)return {ok:false,message:"This UPI transaction reference has already been submitted."};
  const pending=await DB.prepare("SELECT id FROM tenant_upi_payment_requests WHERE property=? AND tenant_phone=? AND status='Pending' LIMIT 1").bind(tenant.property,tenant.phone).first<{id:number}>();
  if(pending)return {ok:false,message:"You already have a payment awaiting admin verification. Please wait for it to be reviewed."};
  await DB.prepare("INSERT INTO tenant_upi_payment_requests(property,tenant_id,tenant_name,tenant_phone,amount,upi_reference) VALUES(?,?,?,?,?,?)").bind(tenant.property,tenant.id,tenant.full_name,tenant.phone,data.amount,data.reference).run();
  return {ok:true,message:"Payment details submitted. Your dues will update after admin verification."};
 });

export const getPendingUpiPayments = createServerFn({method:"POST"})
 .validator(z.object({token:z.string().min(20).max(128),property:z.string().optional()}))
 .handler(async ({data})=>{
  const {DB}=bindings();if(!DB)return {ok:false,rows:[] as PendingUpiRow[]};if(!await managerSession(DB,data.token))return {ok:false,rows:[] as PendingUpiRow[],message:"Manager sign-in required."};
  const result=data.property&&data.property!=="All Properties"
   ?await DB.prepare("SELECT id,property,tenant_id,tenant_name,tenant_phone,amount,upi_reference,status,admin_note,submitted_at FROM tenant_upi_payment_requests WHERE status='Pending' AND property=? ORDER BY submitted_at ASC").bind(data.property).all<PendingUpiRow>()
   :await DB.prepare("SELECT id,property,tenant_id,tenant_name,tenant_phone,amount,upi_reference,status,admin_note,submitted_at FROM tenant_upi_payment_requests WHERE status='Pending' ORDER BY submitted_at ASC").all<PendingUpiRow>();
  return {ok:true,rows:result.results??[]};
 });

export const reviewTenantUpiPayment = createServerFn({method:"POST"})
 .validator(z.object({token:z.string().min(20).max(128),id:z.number().int().positive(),action:z.enum(["approve","reject"]),note:z.string().trim().max(300).default("")}))
 .handler(async ({data})=>{
  const {DB}=bindings();if(!DB)return {ok:false,message:"Database is not enabled."};if(!await managerSession(DB,data.token))return {ok:false,message:"Manager sign-in required."};
  const request=await DB.prepare("SELECT id,property,tenant_id,tenant_name,tenant_phone,amount,upi_reference,status FROM tenant_upi_payment_requests WHERE id=? LIMIT 1").bind(data.id).first<PendingUpiRow>();
  if(!request||request.status!=="Pending")return {ok:false,message:"This payment request is no longer pending. Refresh the list."};
  if(data.action==="reject"){
   await DB.prepare("UPDATE tenant_upi_payment_requests SET status='Rejected',admin_note=?,reviewed_at=datetime('now') WHERE id=? AND status='Pending'").bind(data.note,data.id).run();
   return {ok:true,message:"UPI payment request rejected."};
  }
  const duplicate=await DB.prepare("SELECT id FROM tenant_payments WHERE property=? AND tenant_phone=? AND reference=? LIMIT 1").bind(request.property,request.tenant_phone,request.upi_reference).first<{id:number}>();
  if(duplicate)return {ok:false,message:`This UPI reference is already recorded as payment #${duplicate.id}.`};
  const charges=await DB.prepare("SELECT id,amount,paid_amount FROM tenant_charges WHERE property=? AND tenant_phone=? AND status!='paid' ORDER BY CASE WHEN description='Security deposit' THEN 1 ELSE 0 END,billing_period ASC,CASE charge_type WHEN 'rent' THEN 0 ELSE 1 END,id ASC").bind(request.property,request.tenant_phone).all<{id:number;amount:number;paid_amount:number}>();
  let remaining=request.amount;const allocations:{id:number;amount:number;paid:number;total:number}[]=[];
  for(const charge of charges.results??[]){if(remaining<=0.001)break;const part=Math.min(Math.max(0,charge.amount-charge.paid_amount),remaining);if(part<=0)continue;allocations.push({id:charge.id,amount:part,paid:charge.paid_amount,total:charge.amount});remaining-=part;}
  const applied=request.amount-remaining;if(applied<=0.001)return {ok:false,message:"No outstanding charges are available to allocate this payment."};if(remaining>0.001)return {ok:false,message:"The tenant’s outstanding balance has changed since submission. Reject this request and ask the tenant to submit the corrected amount."};
  // Receipt, allocations, charge balances and request status must commit as one
  // transaction; otherwise a failed allocation batch leaves an orphan receipt.
  const statements=[DB.prepare("INSERT OR IGNORE INTO tenant_payments(property,tenant_name,tenant_phone,amount,payment_method,reference,allocated_amount,upi_request_id) SELECT ?,?,?,?, 'UPI',?,?,? WHERE EXISTS (SELECT 1 FROM tenant_upi_payment_requests WHERE id=? AND status='Pending')")
    .bind(request.property,request.tenant_name,request.tenant_phone,applied,request.upi_reference,applied,request.id,request.id)];
  if(allocations.length){
   const values=allocations.map(()=>"SELECT ? AS charge_id, ? AS amount").join(" UNION ALL ");
   statements.push(DB.prepare(`INSERT INTO tenant_payment_allocations(payment_id,charge_id,allocated_amount)
    SELECT p.id,v.charge_id,v.amount FROM tenant_payments p JOIN (${values}) v WHERE p.upi_request_id=?`)
    .bind(...allocations.flatMap(a=>[a.id,a.amount]),request.id));
  }
  for(const a of allocations){const paid=a.paid+a.amount;statements.push(DB.prepare("UPDATE tenant_charges SET paid_amount=?,status=?,updated_at=datetime('now') WHERE id=? AND EXISTS (SELECT 1 FROM tenant_payments WHERE upi_request_id=?)").bind(paid,paid>=a.total-0.001?"paid":"unpaid",a.id,request.id));}
  statements.push(DB.prepare("UPDATE tenant_upi_payment_requests SET status='Approved',admin_note=?,reviewed_at=datetime('now') WHERE id=? AND status='Pending'").bind(data.note,data.id));
  let results:any[];
  try{results=await DB.batch(statements)}catch{return {ok:false,message:"Payment approval was not saved because the receipt and charge allocations could not be committed together. Refresh and retry."};}
  if(Number(results?.[0]?.meta?.changes||0)<1)return {ok:false,message:"This UPI request has already been reviewed. Refresh the pending list."};
  return {ok:true,message:`Payment approved and ₹${Math.round(applied).toLocaleString("en-IN")} allocated to outstanding charges.`};
 });
