import { getRequestAdmin } from './admin-auth.js';

const ORIGINS = new Set([
  'https://retailers-dashboard.whiteghostpheonix.workers.dev',
  'https://signal-retailers.whiteghostpheonix.workers.dev',
  'https://signal-admin.whiteghostpheonix.workers.dev',
  'https://signal-dashboard.whiteghostpheonix.workers.dev',
  'http://localhost:5173', 'http://localhost:3000',
]);
const OTP_MINUTES = 10;
const SESSION_HOURS = 12;
const emailOf = v => String(v || '').trim().toLowerCase();
const uuid = () => crypto.randomUUID();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async v => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
function randomToken() { const b = new Uint8Array(32); crypto.getRandomValues(b); return hex(b); }
function randomOtp() { const b = new Uint32Array(1); crypto.getRandomValues(b); return String(b[0] % 1000000).padStart(6, '0'); }
async function otpHash(env, email, otp) {
  if (!env.RESEND_API_KEY) throw new Error('Email service is not configured');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RESEND_API_KEY), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${email}:${otp}`)));
}
function reply(data, status, origin) {
  const allow = ORIGINS.has(origin) ? origin : 'https://retailers-dashboard.whiteghostpheonix.workers.dev';
  return Response.json(data, {status, headers:{'Access-Control-Allow-Origin':allow,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'86400','Cache-Control':'no-store','Vary':'Origin'}});
}
function bad(message, status=400) { const e=new Error(message); e.status=status; throw e; }
async function body(req) { try { return await req.json(); } catch { bad('Request body must be valid JSON'); } }

async function ensureSchema(env) {
  const sql = [
`CREATE TABLE IF NOT EXISTS retailer_otp_challenges (id TEXT PRIMARY KEY, retailer_email TEXT NOT NULL, otp_hash TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS retailer_sessions (token_hash TEXT PRIMARY KEY, retailer_email TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS retailer_catalog_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, device_model TEXT NOT NULL, device_type TEXT NOT NULL DEFAULT 'Smartphone', selling_price_ugx INTEGER NOT NULL CHECK(selling_price_ugx>0), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS retailer_catalog_device_plans (catalog_device_id INTEGER NOT NULL, plan_id INTEGER NOT NULL, visible INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(catalog_device_id,plan_id), FOREIGN KEY(catalog_device_id) REFERENCES retailer_catalog_devices(id), FOREIGN KEY(plan_id) REFERENCES payment_plans(id))`,
`CREATE TABLE IF NOT EXISTS retailer_device_plan_rates (retailer_email TEXT NOT NULL, catalog_device_id INTEGER NOT NULL, plan_id INTEGER NOT NULL, rate_percent REAL NOT NULL CHECK(rate_percent>=0 AND rate_percent<=100), active INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(retailer_email,catalog_device_id,plan_id))`,
`CREATE TABLE IF NOT EXISTS retailer_applications (id TEXT PRIMARY KEY, retailer_email TEXT NOT NULL, customer_json TEXT NOT NULL, guarantors_json TEXT NOT NULL, device_json TEXT NOT NULL, catalog_device_id INTEGER NOT NULL, plan_id INTEGER NOT NULL, selling_price_ugx INTEGER NOT NULL, commission_rate_percent REAL NOT NULL, estimated_commission_ugx INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','registered')), decision_reason TEXT, reviewed_by TEXT, reviewed_at TEXT, registered_by TEXT, registered_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS retailer_device_commissions (id TEXT PRIMARY KEY, retailer_email TEXT NOT NULL, application_id TEXT NOT NULL UNIQUE, device_imei TEXT NOT NULL UNIQUE, catalog_device_id INTEGER NOT NULL, plan_id INTEGER NOT NULL, device_model TEXT NOT NULL, plan_name TEXT NOT NULL, device_selling_price_ugx INTEGER NOT NULL, rate_percent REAL NOT NULL, commission_amount_ugx INTEGER NOT NULL CHECK(commission_amount_ugx>=0), status TEXT NOT NULL DEFAULT 'earned' CHECK(status IN ('earned','reserved','paid','void')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS retailer_withdrawals (id TEXT PRIMARY KEY, retailer_email TEXT NOT NULL, amount_ugx INTEGER NOT NULL CHECK(amount_ugx>0), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid')), payout_reference TEXT, reviewed_by TEXT, reviewed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS retailer_notifications (id TEXT PRIMARY KEY, retailer_email TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE INDEX IF NOT EXISTS idx_retailer_apps_email ON retailer_applications(retailer_email,created_at)`,
`CREATE INDEX IF NOT EXISTS idx_retailer_comm_email ON retailer_device_commissions(retailer_email,created_at)`,
`CREATE INDEX IF NOT EXISTS idx_retailer_withdraw_email ON retailer_withdrawals(retailer_email,created_at)`,
  ];
  for (const q of sql) await env.DB.prepare(q).run();
}
async function retailerSession(req, env) {
  const h=req.headers.get('Authorization')||''; if(!h.startsWith('Bearer ')) return null;
  const token=h.slice(7).trim(); if(!/^[a-f0-9]{64}$/.test(token)) return null;
  return env.DB.prepare(`SELECT r.email,r.name,r.phone FROM retailer_sessions s JOIN resellers r ON lower(r.email)=s.retailer_email WHERE s.token_hash=? AND s.expires_at>datetime('now') AND s.revoked_at IS NULL LIMIT 1`).bind(await sha(token)).first();
}
async function sendRetailerOtp(env,email,otp) {
  if(!env.RESEND_API_KEY) throw new Error('Email service is not configured');
  const res=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:'Signal <onboarding@resend.dev>',to:email,subject:'Your Signal retailer sign-in code',html:`<h2>Signal Retailer Portal</h2><p>Your sign-in code is:</p><h1 style="font-family:monospace;letter-spacing:8px">${otp}</h1><p>This code expires in ${OTP_MINUTES} minutes.</p>`,text:`Your Signal retailer sign-in code is ${otp}. It expires in ${OTP_MINUTES} minutes.`})});
  if(!res.ok){console.error('Retailer OTP delivery failed',res.status);throw new Error('Email provider rejected the sign-in email');}
}
async function saveMedia(env, appId, data, key) {
  if(!data) return null;
  if(typeof data!=='string'||data.length>7_000_000) bad(`${key} image is too large (maximum 5 MB)`);
  const m=data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/); if(!m) bad(`${key} must be a JPEG, PNG or WebP camera image`);
  if(!env.MEDIA_BUCKET) bad('Image storage is unavailable',503);
  const bytes=Uint8Array.from(atob(m[2]),c=>c.charCodeAt(0)); if(bytes.length>5*1024*1024) bad(`${key} image is too large (maximum 5 MB)`);
  const path=`retailer-kyc/${appId}/${key}.${m[1].split('/')[1]}`;
  await env.MEDIA_BUCKET.put(path,bytes,{httpMetadata:{contentType:m[1]}}); return path;
}
function cleanText(v,max=250){return String(v||'').trim().slice(0,max);}

export async function handleRetailerWorkflowRoute(request,env) {
 const url=new URL(request.url),path=url.pathname.replace(/\/+$/,'')||'/',method=request.method,origin=request.headers.get('Origin')||'';
 const retailerPath=path.startsWith('/api/retailer/');
 const adminPath=path.startsWith('/api/admin/retailer/');
 if(!retailerPath&&!adminPath)return null;
 try {
  await ensureSchema(env);
  if(path==='/api/retailer/request-otp'&&method==='POST'){
   const b=await body(request),email=emailOf(b.email);
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))bad('Enter a valid registered retailer email');
   const retailer=await env.DB.prepare('SELECT email FROM resellers WHERE lower(email)=? LIMIT 1').bind(email).first();
   if(!retailer)return reply({error:'This email is not registered as a retailer. Contact an admin.'},403,origin);
   const recent=await env.DB.prepare("SELECT COUNT(*) count FROM retailer_otp_challenges WHERE retailer_email=? AND created_at>datetime('now','-15 minutes')").bind(email).first();
   if(Number(recent?.count||0)>=3)return reply({error:'Too many codes requested. Wait 15 minutes.'},429,origin);
   const otp=randomOtp(); await env.DB.prepare("INSERT INTO retailer_otp_challenges(id,retailer_email,otp_hash,expires_at) VALUES(?,?,?,datetime('now','+10 minutes'))").bind(uuid(),email,await otpHash(env,email,otp)).run();
   await sendRetailerOtp(env,email,otp); return reply({ok:true,message:'Sign-in code sent to the registered retailer email.'},200,origin);
  }
  if(path==='/api/retailer/verify-otp'&&method==='POST'){
   const b=await body(request),email=emailOf(b.email),otp=String(b.code||b.otp||'').trim();
   if(!/^\d{6}$/.test(otp))bad('Invalid or expired code',401);
   const r=await env.DB.prepare('SELECT email FROM resellers WHERE lower(email)=?').bind(email).first(); if(!r)bad('Invalid or expired code',401);
   const ch=await env.DB.prepare("SELECT id,otp_hash,attempts FROM retailer_otp_challenges WHERE retailer_email=? AND consumed_at IS NULL AND expires_at>datetime('now') ORDER BY created_at DESC LIMIT 1").bind(email).first();
   if(!ch||Number(ch.attempts)>=5)bad('Invalid or expired code',401);
   if(await otpHash(env,email,otp)!==ch.otp_hash){await env.DB.prepare('UPDATE retailer_otp_challenges SET attempts=attempts+1 WHERE id=?').bind(ch.id).run();bad('Invalid or expired code',401);}
   await env.DB.prepare("UPDATE retailer_otp_challenges SET consumed_at=datetime('now') WHERE id=?").bind(ch.id).run();
   const token=randomToken(); await env.DB.prepare("INSERT INTO retailer_sessions(token_hash,retailer_email,expires_at) VALUES(?,?,datetime('now','+12 hours'))").bind(await sha(token),email).run();
   return reply({ok:true,token,email},200,origin);
  }
  if(path==='/api/retailer/logout'&&method==='POST'){
   const h=request.headers.get('Authorization')||'',t=h.startsWith('Bearer ')?h.slice(7).trim():''; if(/^[a-f0-9]{64}$/.test(t))await env.DB.prepare("UPDATE retailer_sessions SET revoked_at=datetime('now') WHERE token_hash=?").bind(await sha(t)).run(); return reply({ok:true},200,origin);
  }
  if(retailerPath){
   const retailer=await retailerSession(request,env); if(!retailer)return reply({error:'Unauthorized'},401,origin); const email=emailOf(retailer.email);
   if(path==='/api/retailer/catalog'&&method==='GET'){
    const q=await env.DB.prepare(`SELECT d.id,d.device_model,d.device_type,d.selling_price_ugx FROM retailer_catalog_devices d WHERE d.active=1 AND EXISTS(SELECT 1 FROM retailer_catalog_device_plans p WHERE p.catalog_device_id=d.id AND p.visible=1) ORDER BY d.device_model`).all();
    return reply({devices:q.results||[]},200,origin);
   }
   if(path==='/api/retailer/plans'&&method==='GET'){
    const deviceId=Number(url.searchParams.get('catalog_device_id')||0);
    const q=deviceId?await env.DB.prepare(`SELECT p.id,p.plan_name,p.total_amount_ugx,p.frequency FROM payment_plans p JOIN retailer_catalog_device_plans v ON v.plan_id=p.id WHERE v.catalog_device_id=? AND v.visible=1 ORDER BY p.id`).bind(deviceId).all():await env.DB.prepare(`SELECT DISTINCT p.id,p.plan_name,p.total_amount_ugx,p.frequency FROM payment_plans p JOIN retailer_catalog_device_plans v ON v.plan_id=p.id WHERE v.visible=1 ORDER BY p.id`).all();
    const plans=[];for(const p of q.results||[]){const d=deviceId?{id:deviceId}:null;const rates=d?await env.DB.prepare('SELECT rate_percent FROM retailer_device_plan_rates WHERE retailer_email=? AND catalog_device_id=? AND plan_id=? AND active=1').bind(email,d.id,p.id).first():null;const pct=Number(rates?.rate_percent||0);const price=d?await env.DB.prepare('SELECT selling_price_ugx FROM retailer_catalog_devices WHERE id=?').bind(d.id).first():null;plans.push({...p,commission_rate_percent:pct,commission_rate_configured:Boolean(rates),commission_amount_ugx:Math.round(Number(price?.selling_price_ugx||0)*pct/100)});}
    return reply(plans,200,origin);
   }
   if(path==='/api/retailer/applications'&&method==='POST'){
    const b=await body(request),c=b.customer||{},g=Array.isArray(b.guarantors)?b.guarantors:[],d=b.device||{},deviceId=Number(b.catalog_device_id||d.catalog_device_id),planId=Number(b.plan_id);
    if(!cleanText(c.full_name)||!cleanText(c.nin))bad('Customer full name and NIN are required');
    if(!/^(CM|CF)[A-Z0-9]{12}$/.test(cleanText(c.nin,30).toUpperCase()))bad('Enter a valid Uganda NIN (CM/CF plus 12 characters)');
    if(g.length>2||g.some(x=>(cleanText(x.full_name)||cleanText(x.phone))&&(!cleanText(x.full_name)||!cleanText(x.phone))))bad('Complete both name and phone for each guarantor you enter');
    if(!/^\d{10,17}$/.test(cleanText(d.imei,20)))bad('Enter a valid device IMEI');
    const catalog=await env.DB.prepare('SELECT * FROM retailer_catalog_devices WHERE id=? AND active=1').bind(deviceId).first();if(!catalog)bad('Selected device is not available');
    const plan=await env.DB.prepare(`SELECT p.* FROM payment_plans p JOIN retailer_catalog_device_plans v ON v.plan_id=p.id WHERE p.id=? AND v.catalog_device_id=? AND v.visible=1`).bind(planId,deviceId).first();if(!plan)bad('Selected plan is not visible for this device');
    const rate=await env.DB.prepare('SELECT rate_percent FROM retailer_device_plan_rates WHERE retailer_email=? AND catalog_device_id=? AND plan_id=? AND active=1').bind(email,deviceId,planId).first();if(!rate)bad('Commission rate has not been configured for this retailer, device and plan',409);
    const ratePercent=Number(rate.rate_percent||0),commission=Math.round(Number(catalog.selling_price_ugx)*ratePercent/100),id=uuid();
    const customer={full_name:cleanText(c.full_name),phone:cleanText(c.phone,40),nin:cleanText(c.nin,30).toUpperCase(),dob:cleanText(c.dob,20),address:cleanText(c.address,500),occupation:cleanText(c.occupation,120),monthly_income:Number(c.monthly_income||0),media:{}};
    const guarantors=g.map(x=>({full_name:cleanText(x.full_name),phone:cleanText(x.phone,40),nin:cleanText(x.nin,30).toUpperCase(),relationship:cleanText(x.relationship,80),address:cleanText(x.address,500),occupation:cleanText(x.occupation,120),media:{}}));
    const dev={imei:cleanText(d.imei,20),device_model:catalog.device_model,device_type:catalog.device_type,color:cleanText(d.color,60),catalog_device_id:deviceId};
    const mediaFields=[['customer_photo',c.photo_base64,customer.media],['customer_photo_with_retailer',c.photo_with_reseller_base64,customer.media],['customer_nin_front',c.id_front_base64,customer.media],['customer_nin_back',c.id_back_base64,customer.media],['device_photo',d.photo_base64||c.device_photo_base64,customer.media]];
    for(let i=0;i<g.length;i++){mediaFields.push([`guarantor${i+1}_photo`,g[i].photo_base64,guarantors[i].media],[`guarantor${i+1}_nin`,g[i].id_front_base64,guarantors[i].media]);}
    for(const [key,value,target] of mediaFields){const stored=await saveMedia(env,id,value,key);if(stored)target[key]=stored;}
    await env.DB.prepare(`INSERT INTO retailer_applications(id,retailer_email,customer_json,guarantors_json,device_json,catalog_device_id,plan_id,selling_price_ugx,commission_rate_percent,estimated_commission_ugx) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id,email,JSON.stringify(customer),JSON.stringify(guarantors),JSON.stringify(dev),deviceId,planId,catalog.selling_price_ugx,ratePercent,commission).run();
    await env.DB.prepare('INSERT INTO retailer_notifications(id,retailer_email,kind,message) VALUES(?,?,?,?)').bind(uuid(),email,'application_submitted',`Customer application ${id} has been submitted for admin review.`).run();
    return reply({ok:true,id,commission:{rate_percent:ratePercent,commission_amount_ugx:commission}},201,origin);
   }
   if(path==='/api/retailer/applications'&&method==='GET'){
    const q=await env.DB.prepare('SELECT a.*,p.plan_name FROM retailer_applications a LEFT JOIN payment_plans p ON p.id=a.plan_id WHERE a.retailer_email=? ORDER BY a.created_at DESC LIMIT 100').bind(email).all();
    return reply((q.results||[]).map(a=>({id:a.id,status:a.status,created_at:a.created_at,reviewed_at:a.reviewed_at,denial_reason:a.decision_reason,customer:JSON.parse(a.customer_json),guarantors:JSON.parse(a.guarantors_json),device:{...JSON.parse(a.device_json),selling_price_ugx:a.selling_price_ugx},plan:{id:a.plan_id,plan_name:a.plan_name},commission:{rate_percent:a.commission_rate_percent,commission_amount_ugx:a.estimated_commission_ugx}})),200,origin);
   }
   if(path==='/api/retailer/notifications'&&method==='GET'){const q=await env.DB.prepare('SELECT * FROM retailer_notifications WHERE retailer_email=? ORDER BY created_at DESC LIMIT 100').bind(email).all();return reply(q.results||[],200,origin);}
   if(path==='/api/retailer/withdrawals'&&method==='GET'){
    const commissions=await env.DB.prepare("SELECT COALESCE(SUM(commission_amount_ugx),0) earned FROM retailer_device_commissions WHERE retailer_email=? AND status IN ('earned','reserved','paid')").bind(email).first();
    const w=await env.DB.prepare('SELECT * FROM retailer_withdrawals WHERE retailer_email=? ORDER BY created_at DESC').bind(email).all();
    const reserved=(w.results||[]).filter(x=>['pending','approved','paid'].includes(x.status)).reduce((s,x)=>s+Number(x.amount_ugx),0);
    const earned=Number(commissions?.earned||0);const paid=(w.results||[]).filter(x=>x.status==='paid').reduce((s,x)=>s+Number(x.amount_ugx),0);
    const commissionsRows=await env.DB.prepare('SELECT * FROM retailer_device_commissions WHERE retailer_email=? ORDER BY created_at DESC').bind(email).all();
    return reply({earned_ugx:earned,withdrawn_or_reserved_ugx:reserved,available_ugx:Math.max(0,earned-reserved),withdrawals:w.results||[],commissions:commissionsRows.results||[]},200,origin);
   }
   if(path==='/api/retailer/withdrawals'&&method==='POST'){
    const b=await body(request),amount=Number(b.amount_ugx);if(!Number.isSafeInteger(amount)||amount<=0)bad('Enter a positive whole-number withdrawal amount');
    const data=await env.DB.prepare("SELECT COALESCE(SUM(commission_amount_ugx),0) earned FROM retailer_device_commissions WHERE retailer_email=? AND status IN ('earned','reserved','paid')").bind(email).first();
    const rows=await env.DB.prepare("SELECT COALESCE(SUM(amount_ugx),0) reserved FROM retailer_withdrawals WHERE retailer_email=? AND status IN ('pending','approved','paid')").bind(email).first();
    if(amount>Number(data?.earned||0)-Number(rows?.reserved||0))bad('Withdrawal exceeds your available earned commission',409);
    const id=uuid();await env.DB.prepare('INSERT INTO retailer_withdrawals(id,retailer_email,amount_ugx) VALUES(?,?,?)').bind(id,email,amount).run();
    await env.DB.prepare('INSERT INTO retailer_notifications(id,retailer_email,kind,message) VALUES(?,?,?,?)').bind(uuid(),email,'withdrawal_requested',`Withdrawal request ${id} for UGX ${amount.toLocaleString('en-US')} is awaiting admin review.`).run();return reply({ok:true,id},201,origin);
   }
   return reply({error:'Retailer endpoint not found'},404,origin);
  }
  const admin=await getRequestAdmin(request,env);if(!admin)return reply({error:'Unauthorized'},401,origin);
  if(path==='/api/admin/retailer/media'&&method==='GET'){
   const appId=cleanText(url.searchParams.get('application_id'),80),key=cleanText(url.searchParams.get('key'),300);
   if(!appId||!key.startsWith(`retailer-kyc/${appId}/`))bad('Invalid KYC media reference',400);
   const row=await env.DB.prepare('SELECT id FROM retailer_applications WHERE id=?').bind(appId).first();if(!row)return reply({error:'Application not found'},404,origin);
   const object=await env.MEDIA_BUCKET.get(key);if(!object)return reply({error:'KYC image not found'},404,origin);
   const bytes=new Uint8Array(await object.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
   const type=object.httpMetadata?.contentType||'image/jpeg';return reply({data_url:`data:${type};base64,${btoa(binary)}`},200,origin);
  }
  if(path==='/api/admin/retailer/catalog'&&method==='GET'){
   const q=await env.DB.prepare('SELECT * FROM retailer_catalog_devices ORDER BY created_at DESC').all();const p=await env.DB.prepare('SELECT * FROM retailer_catalog_device_plans').all();return reply({devices:q.results||[],device_plans:p.results||[]},200,origin);
  }
  if(path==='/api/admin/retailer/catalog'&&method==='POST'){
   const b=await body(request),model=cleanText(b.device_model,160),type=cleanText(b.device_type||'Smartphone',80),price=Number(b.selling_price_ugx),plans=Array.isArray(b.plan_ids)?[...new Set(b.plan_ids.map(Number).filter(Number.isSafeInteger))]:[];
   if(!model||!Number.isSafeInteger(price)||price<=0||!plans.length)bad('Device model, positive selling price and at least one plan are required');
   const id=Number(b.id||0);let catalogId=id;if(id){await env.DB.prepare('UPDATE retailer_catalog_devices SET device_model=?,device_type=?,selling_price_ugx=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(model,type,price,b.active===false?0:1,id).run();}else{const ins=await env.DB.prepare('INSERT INTO retailer_catalog_devices(device_model,device_type,selling_price_ugx) VALUES(?,?,?)').bind(model,type,price).run();catalogId=Number(ins?.meta?.last_row_id||0);}
   const row={id:catalogId};if(!row.id)bad('Could not create retailer catalogue device',500);
   for(const pid of plans){const valid=await env.DB.prepare('SELECT id FROM payment_plans WHERE id=?').bind(pid).first();if(!valid)bad(`Payment plan ${pid} does not exist`);await env.DB.prepare('INSERT INTO retailer_catalog_device_plans(catalog_device_id,plan_id,visible) VALUES(?,?,1) ON CONFLICT(catalog_device_id,plan_id) DO UPDATE SET visible=1').bind(row.id,pid).run();}
   await env.DB.prepare('UPDATE retailer_catalog_device_plans SET visible=0 WHERE catalog_device_id=? AND plan_id NOT IN ('+plans.map(()=>'?').join(',')+')').bind(row.id,...plans).run();
   return reply({ok:true,id:row.id},200,origin);
  }
  if(path==='/api/admin/retailer/plans'&&method==='GET'){const q=await env.DB.prepare('SELECT id,plan_name,total_amount_ugx,frequency FROM payment_plans ORDER BY id').all();const v=await env.DB.prepare('SELECT * FROM retailer_catalog_device_plans').all();return reply({plans:q.results||[],visibility:v.results||[]},200,origin);}
  if(path==='/api/admin/retailer/commission-rates'&&method==='GET'){const q=await env.DB.prepare('SELECT * FROM retailer_device_plan_rates ORDER BY retailer_email,catalog_device_id,plan_id').all();const r=await env.DB.prepare('SELECT email,name FROM resellers ORDER BY email').all();return reply({rates:q.results||[],retailers:r.results||[]},200,origin);}
  if(path==='/api/admin/retailer/commission-rates'&&method==='POST'){
   const b=await body(request),email=emailOf(b.retailer_email),deviceId=Number(b.catalog_device_id),planId=Number(b.plan_id),rate=Number(b.rate_percent);if(!Number.isFinite(rate)||rate<0||rate>100)bad('Commission rate must be between 0 and 100');
   const retailer=await env.DB.prepare('SELECT email FROM resellers WHERE lower(email)=?').bind(email).first();if(!retailer)bad('Retailer is not registered',404);
   const valid=await env.DB.prepare('SELECT 1 ok FROM retailer_catalog_device_plans WHERE catalog_device_id=? AND plan_id=? AND visible=1').bind(deviceId,planId).first();if(!valid)bad('Device and plan are not enabled together');
   await env.DB.prepare(`INSERT INTO retailer_device_plan_rates(retailer_email,catalog_device_id,plan_id,rate_percent,active,updated_by) VALUES(?,?,?,?,1,?) ON CONFLICT(retailer_email,catalog_device_id,plan_id) DO UPDATE SET rate_percent=excluded.rate_percent,active=1,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).bind(email,deviceId,planId,rate,admin.email).run();return reply({ok:true},200,origin);
  }
  if(path==='/api/admin/retailer/applications'&&method==='GET'){
   const q=await env.DB.prepare('SELECT * FROM retailer_applications ORDER BY created_at DESC LIMIT 200').all();return reply({applications:(q.results||[]).map(a=>({...a,customer:JSON.parse(a.customer_json),guarantors:JSON.parse(a.guarantors_json),device:JSON.parse(a.device_json)}))},200,origin);
  }
  const decision=path.match(/^\/api\/admin\/retailer\/applications\/([^/]+)\/decision$/);
  if(decision&&method==='POST'){
   const id=decodeURIComponent(decision[1]),b=await body(request),choice=String(b.decision||'').toLowerCase(),reason=cleanText(b.reason,1000);if(!['approve','reject'].includes(choice))bad('Decision must be approve or reject');if(choice==='reject'&&!reason)bad('A rejection reason is required');
   const a=await env.DB.prepare('SELECT * FROM retailer_applications WHERE id=?').bind(id).first();if(!a)return reply({error:'Application not found'},404,origin);if(a.status!=='pending')return reply({error:'Application is no longer pending'},409,origin);
   const status=choice==='approve'?'approved':'rejected';await env.DB.prepare("UPDATE retailer_applications SET status=?,decision_reason=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(status,reason||null,admin.email,id).run();
   await env.DB.prepare('INSERT INTO retailer_notifications(id,retailer_email,kind,message) VALUES(?,?,?,?)').bind(uuid(),a.retailer_email,'application_'+status,`Your customer application ${id} was ${status}.${reason?' Reason: '+reason:''}`).run();return reply({ok:true,status},200,origin);
  }
  const register=path.match(/^\/api\/admin\/retailer\/applications\/([^/]+)\/register$/);
  if(register&&method==='POST'){
   const id=decodeURIComponent(register[1]),b=await body(request);
   const a=await env.DB.prepare('SELECT * FROM retailer_applications WHERE id=?').bind(id).first();if(!a)return reply({error:'Application not found'},404,origin);if(a.status!=='approved')bad('Only approved applications can be registered',409);
   const d=JSON.parse(a.device_json),c=JSON.parse(a.customer_json),gs=JSON.parse(a.guarantors_json),imei=cleanText(b.imei||d.imei,20);if(!/^\d{10,17}$/.test(imei))bad('Enter a valid device IMEI');
   const p=await env.DB.prepare('SELECT * FROM payment_plans WHERE id=?').bind(a.plan_id).first();if(!p)bad('Selected plan no longer exists');
   const exists=await env.DB.prepare('SELECT imei FROM devices WHERE imei=?').bind(imei).first();if(exists)bad('This IMEI is already registered',409);
   const installments=await env.DB.prepare('SELECT installment_number,offset_days,amount_ugx FROM plan_installments WHERE plan_id=? ORDER BY installment_number').bind(a.plan_id).all();
   const scheduleRows=installments.results?.length?installments.results:Array.from({length:Math.max(1,Math.min(600,Number(p.installment_count)||1))},(_,i)=>({installment_number:i+1,offset_days:(i+1)*(/week/i.test(p.frequency||'')?7:/month/i.test(p.frequency||'')?30:1),amount_ugx:Number(p.amount_per_period)||Math.ceil(Number(p.total_amount_ugx||0)/Math.max(1,Number(p.installment_count)||1))}));
   const rate=Number(a.commission_rate_percent),amount=Math.round(Number(a.selling_price_ugx)*rate/100),customerMedia=c.media||{},now=new Date();
   const addDays=(n)=>{const x=new Date(now);x.setDate(x.getDate()+Number(n||0));return x.toISOString().slice(0,10);};
   const statements=[
    env.DB.prepare("INSERT INTO devices(imei,customer_name,customer_phone,status,reseller_email) VALUES(?,?,?,'active',?)").bind(imei,c.full_name,c.phone||null,a.retailer_email),
    env.DB.prepare('INSERT INTO customers(imei,full_name,phone,nin,dob,address,photo_url,photo_with_reseller_url,device_photo_url,id_front_url,id_back_url,occupation,monthly_income,kyc_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(imei,c.full_name,c.phone||null,c.nin,c.dob||null,c.address||null,customerMedia.customer_photo||null,customerMedia.customer_photo_with_retailer||null,customerMedia.device_photo||null,customerMedia.customer_nin_front||null,customerMedia.customer_nin_back||null,c.occupation||null,Number(c.monthly_income||0),'pending'),
    ...gs.map((g,i)=>env.DB.prepare('INSERT INTO guarantors(customer_imei,slot,full_name,phone,nin,relationship,address,photo_url,id_front_url,occupation) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(imei,i+1,g.full_name,g.phone,g.nin||null,g.relationship||null,g.address||null,g.media?.[`guarantor${i+1}_photo`]||null,g.media?.[`guarantor${i+1}_nin`]||null,g.occupation||null)),
    ...scheduleRows.map(row=>env.DB.prepare("INSERT INTO schedules(device_imei,plan_id,installment_number,due_date,amount_due_ugx,status) VALUES(?,?,?,?,?,'pending')").bind(imei,a.plan_id,row.installment_number,addDays(row.offset_days),row.amount_ugx)),
    env.DB.prepare("UPDATE retailer_applications SET status='registered',device_json=?,registered_by=?,registered_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='approved'").bind(JSON.stringify({...d,imei}),admin.email,id),
    env.DB.prepare('INSERT INTO retailer_device_commissions(id,retailer_email,application_id,device_imei,catalog_device_id,plan_id,device_model,plan_name,device_selling_price_ugx,rate_percent,commission_amount_ugx) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(uuid(),a.retailer_email,id,imei,a.catalog_device_id,a.plan_id,d.device_model,p.plan_name,a.selling_price_ugx,rate,amount),
    env.DB.prepare('INSERT INTO retailer_notifications(id,retailer_email,kind,message) VALUES(?,?,?,?)').bind(uuid(),a.retailer_email,'device_registered',`Device ${d.device_model} (${imei}) was registered with ${p.plan_name}. Commission earned: UGX ${amount.toLocaleString('en-US')}.`),
   ];
   await env.DB.batch(statements);return reply({ok:true,device_imei:imei,plan_id:a.plan_id,installments_created:scheduleRows.length,commission_amount_ugx:amount},201,origin);
  }
  if(path==='/api/admin/retailer/commissions'&&method==='GET'){const q=await env.DB.prepare('SELECT * FROM retailer_device_commissions ORDER BY created_at DESC LIMIT 500').all();return reply({commissions:q.results||[]},200,origin);}
  if(path==='/api/admin/retailer/withdrawals'&&method==='GET'){const q=await env.DB.prepare('SELECT * FROM retailer_withdrawals ORDER BY created_at DESC LIMIT 200').all();return reply({withdrawals:q.results||[]},200,origin);}
  const wd=path.match(/^\/api\/admin\/retailer\/withdrawals\/([^/]+)\/decision$/);
  if(wd&&method==='POST'){
   const id=decodeURIComponent(wd[1]),b=await body(request),choice=String(b.decision||'').toLowerCase(),ref=cleanText(b.payout_reference,160);if(!['approve','reject','paid'].includes(choice))bad('Decision must be approve, reject or paid');
   const row=await env.DB.prepare('SELECT * FROM retailer_withdrawals WHERE id=?').bind(id).first();if(!row)return reply({error:'Withdrawal not found'},404,origin);if(row.status==='paid'||row.status==='rejected')bad('Withdrawal is already closed',409);if(choice==='paid'&&!ref)bad('Payout reference is required to mark paid');
   const status=choice==='approve'?'approved':choice==='reject'?'rejected':'paid';await env.DB.prepare('UPDATE retailer_withdrawals SET status=?,payout_reference=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?').bind(status,ref||null,admin.email,id).run();await env.DB.prepare('INSERT INTO retailer_notifications(id,retailer_email,kind,message) VALUES(?,?,?,?)').bind(uuid(),row.retailer_email,'withdrawal_'+status,`Your withdrawal ${id} is ${status}.${ref?' Reference: '+ref:''}`).run();return reply({ok:true,status},200,origin);
  }
  return reply({error:'Admin retailer endpoint not found'},404,origin);
 }catch(e){const status=Number.isInteger(e.status)?e.status:500;console.error('Retailer workflow error',path,method,e.message);return reply({error:status>=500?'The request could not be completed':e.message},status,origin);}
}
