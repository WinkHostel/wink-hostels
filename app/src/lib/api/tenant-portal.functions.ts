import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";
import { sessionTenantForPayments } from "./tenant-portal.server";

type PortalChargeRow = {id:number;billing_period:string;charge_type:string;description:string;amount:number;paid_amount:number;status:string;due_date:string|null;invoice_number:string|null;updated_at:string};
type PortalPaymentRow = {id:number;amount:number;payment_method:string;reference:string;created_at:string};
type PortalTicketRow = {id:number;category:string;title:string;description:string;priority:string;status:string;created_at:string;updated_at:string};
type PortalMoveoutRow = {id:number;requested_date:string;reason:string;status:string;created_at:string};
async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}


export const tenantPortalLogout = createServerFn({method:"POST"}).validator(z.object({token:z.string().min(1).max(128)})).handler(async({data})=>{const {DB}=bindings();if(DB)await DB.prepare("DELETE FROM tenant_portal_sessions WHERE token_hash=?").bind(await digest(data.token)).run();return {ok:true};});

export const getTenantPortalHome = createServerFn({method:"POST"}).validator(z.object({token:z.string().min(1).max(128)})).handler(async({data})=>{
 const {DB}=bindings();if(!DB)return {ok:false,message:"Portal unavailable."};
 const tenant=await sessionTenantForPayments(data.token);if(!tenant)return {ok:false,message:"Your session has expired. Please sign in again."};
 // Backfill security deposits in the portal ledger just as the admin ledger does.
 if(Number(tenant.security_deposit||0)>0){
  await DB.prepare("INSERT OR IGNORE INTO tenant_charges(property,tenant_name,tenant_phone,room,billing_period,charge_type,description,amount,paid_amount,status,due_date,invoice_number,updated_at) SELECT t.property,t.full_name,t.phone,t.room,substr(COALESCE(t.move_in_date,t.joined_on,date('now')),1,7)||'-DEPOSIT','rent','Security deposit',t.security_deposit,0,'unpaid',COALESCE(t.move_in_date,t.joined_on,date('now')),'WH-DEP-'||replace(substr(COALESCE(t.move_in_date,t.joined_on,date('now')),1,7),'-','')||'-'||substr(replace(t.phone,' ',''),-4),datetime('now') FROM tenants t WHERE t.id=? AND COALESCE(t.security_deposit,0)>0 AND NOT EXISTS(SELECT 1 FROM tenant_charges c WHERE c.property=t.property AND c.tenant_phone=t.phone AND lower(c.description)='security deposit')").bind(tenant.id).run();
 }
 const [charges,payments,tickets,moves,profile,configRow,docs,propertyRow]=await Promise.all([
  DB.prepare("SELECT id,billing_period,charge_type,description,amount,paid_amount,status,due_date,invoice_number,updated_at FROM tenant_charges WHERE property=? AND tenant_phone=? ORDER BY billing_period DESC,id DESC LIMIT 100").bind(tenant.property,tenant.phone).all<PortalChargeRow>(),
  DB.prepare("SELECT id,amount,payment_method,reference,created_at FROM tenant_payments WHERE property=? AND tenant_phone=? ORDER BY created_at DESC LIMIT 50").bind(tenant.property,tenant.phone).all<PortalPaymentRow>(),
  DB.prepare("SELECT id,category,title,description,priority,status,created_at,updated_at FROM maintenance_requests WHERE property=? AND tenant_phone=? ORDER BY created_at DESC LIMIT 50").bind(tenant.property,tenant.phone).all<PortalTicketRow>(),
  DB.prepare("SELECT id,requested_date,reason,status,created_at FROM tenant_moveout_requests WHERE tenant_id=? ORDER BY created_at DESC LIMIT 10").bind(tenant.id).all<PortalMoveoutRow>(),
  DB.prepare("SELECT blood_group,guardian_name,guardian_phone,occupation,permanent_address,emergency_contact_name,emergency_contact_phone,submitted_at FROM tenant_onboarding_profiles WHERE tenant_id=?").bind(tenant.id).first<any>(),
  DB.prepare("SELECT mandatory_fields_json,mandatory_documents_json FROM property_onboarding_configs WHERE property=?").bind(tenant.property).first<any>(),
  DB.prepare("SELECT id,document_name,content_type,document_type,review_status,review_note,created_at FROM tenant_kyc_documents WHERE tenant_id=? AND is_current=1 ORDER BY created_at DESC,id DESC").bind(tenant.id).all<any>(),
  DB.prepare("SELECT contact_phone FROM properties WHERE name=?").bind(tenant.property).first<any>()
 ]);
 const settingsRow=await DB.prepare("SELECT setting_value FROM app_settings WHERE setting_key='business-settings'").first<{setting_value:string}>();let upiId="";try{upiId=String(JSON.parse(settingsRow?.setting_value||"{}").upiId||"").trim()}catch{}
 let mandatoryFields:string[]=["permanent_address","emergency_contact_name","emergency_contact_phone","profile_photo","aadhaar"],mandatoryDocuments:string[]=["aadhaar"];
 try{if(configRow){mandatoryFields=JSON.parse(configRow.mandatory_fields_json);mandatoryDocuments=JSON.parse(configRow.mandatory_documents_json)}}catch{}
 const p=profile||{blood_group:"",guardian_name:"",guardian_phone:"",occupation:"",permanent_address:"",emergency_contact_name:"",emergency_contact_phone:"",submitted_at:null};
 const currentDocs=docs.results||[];
 // Re-evaluate completion against the property's CURRENT rules on every portal
 // load. If an admin adds a mandatory field/document later, the tenant is gated
 // again until the newly required information is supplied.
 const profileValues:Record<string,string>={permanent_address:p.permanent_address||"",emergency_contact_name:p.emergency_contact_name||"",emergency_contact_phone:p.emergency_contact_phone||"",blood_group:p.blood_group||"",occupation:p.occupation||""};
 const hasCurrentDocument=(type:string)=>currentDocs.some((doc:any)=>doc.document_type===type&&doc.is_current!==0&&doc.review_status!=="Rejected");
 const documentFields=["profile_photo","aadhaar","company_college_id"];
 const missingFields=mandatoryFields.filter(key=>documentFields.includes(key)?!hasCurrentDocument(key):!String(profileValues[key]||"").trim());
 const missingDocuments=mandatoryDocuments.filter(key=>!hasCurrentDocument(key));
 const completed=!!p.submitted_at&&!missingFields.length&&!missingDocuments.length;
 const missingRequirements=[...missingFields.map(key=>key.replaceAll("_"," ")),...missingDocuments.map(key=>key.replaceAll("_"," ")+" document")];
 const contact=String(propertyRow?.contact_phone||"").replace(/\D/g,"");
 const upiRequest=await DB.prepare("SELECT id,amount,upi_reference,status,admin_note,submitted_at FROM tenant_upi_payment_requests WHERE property=? AND tenant_phone=? ORDER BY submitted_at DESC,id DESC LIMIT 1").bind(tenant.property,tenant.phone).first<any>();
 return {ok:true,tenant:{id:tenant.id,name:tenant.full_name,property:tenant.property,room:tenant.room,phone:tenant.phone,rent:Number(tenant.monthly_rent||0),deposit:Number(tenant.security_deposit||0),status:tenant.status,kycStatus:tenant.kyc_status||"Pending",joined:tenant.joined_on,rentCycle:tenant.rent_cycle||"1st of every month",moveInDate:tenant.move_in_date||tenant.joined_on,noticePeriodDays:Number(tenant.notice_period_days??30)},upiId,kycMandatoryFields:mandatoryFields,onboarding:{completed,missingRequirements,submittedAt:p.submitted_at||null,profile:{bloodGroup:p.blood_group||"",occupation:p.occupation||"",permanentAddress:p.permanent_address||"",emergencyContactName:p.emergency_contact_name||"",emergencyContactPhone:p.emergency_contact_phone||""},mandatoryFields,mandatoryDocuments,documents:currentDocs,contactPhone:/^[6-9]\d{9}$/.test(contact)?contact:"7200352252"},upiRequest:upiRequest??null,charges:charges.results??[],payments:payments.results??[],tickets:tickets.results??[],moveouts:moves.results??[]};
});

export const tenantPortalCreateTicket = createServerFn({method:"POST"}).validator(z.object({token:z.string().min(1).max(128),category:z.enum(["Electrical","Plumbing","Cleaning","Appliance","Internet","Security","General"]),title:z.string().trim().min(3).max(160),description:z.string().trim().max(2000).default(""),priority:z.enum(["Low","Normal","High","Urgent"]).default("Normal")})).handler(async({data})=>{const {DB}=bindings();if(!DB)return {ok:false,message:"Portal unavailable."};const t=await sessionTenantForPayments(data.token);if(!t)return {ok:false,message:"Session expired. Please sign in again."};const result=await DB.prepare("INSERT INTO maintenance_requests(property,room,tenant_name,tenant_phone,category,title,description,priority) VALUES(?,?,?,?,?,?,?,?)").bind(t.property,t.room,t.full_name,t.phone,data.category,data.title,data.description,data.priority).run();return {ok:true,id:Number(result.meta?.last_row_id)};});

export const tenantPortalRequestMoveout = createServerFn({method:"POST"}).validator(z.object({token:z.string().min(1).max(128),requestedDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),reason:z.string().trim().max(1000).default("")})).handler(async({data})=>{const {DB}=bindings();if(!DB)return {ok:false,message:"Portal unavailable."};const t=await sessionTenantForPayments(data.token);if(!t)return {ok:false,message:"Session expired. Please sign in again."};const existing=await DB.prepare("SELECT id FROM tenant_moveout_requests WHERE tenant_id=? AND status='Requested' LIMIT 1").bind(t.id).first();if(existing)return {ok:false,message:"You already have a move-out request awaiting review."};await DB.prepare("INSERT INTO tenant_moveout_requests(tenant_id,property,tenant_name,phone,requested_date,reason) VALUES(?,?,?,?,?,?)").bind(t.id,t.property,t.full_name,t.phone,data.requestedDate,data.reason).run();return {ok:true,message:"Move-out request sent to management for review."};});
