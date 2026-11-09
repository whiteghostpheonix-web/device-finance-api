const json=(data,status=200)=>Response.json(data,{status,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, Authorization","Cache-Control":"no-store"}});
const uuid=()=>crypto.randomUUID();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function hash(v){return hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)));}
const emailOf=v=>typeof v==="string"?v.trim().toLowerCase():"";
async function sendOtp(env,email,otp){
 if(!env.RESEND_API_KEY||!env.RESEND_FROM_EMAIL)throw new Error("Email service is not configured");
 const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:env.RESEND_FROM_EMAIL,to:[email],subject:"Signal Electronics admin sign-in code",text:"Your sign-in code is "+otp+". It expires in 10 minutes."})});
 if(!r.ok)throw new Error("OTP delivery failed");
}
async function bootstrap(env,email){
 const row=await env.DB.prepare("SELECT id FROM admin_users WHERE email=?").bind(email).first();
 if(!row)await env.DB.prepare("INSERT INTO admin_users(id,email,display_name,role,active) VALUES(?,?,?,?,1)").bind(uuid(),email,"Supreme Admin","super_admin").run();
 else await env.DB.prepare("UPDATE admin_users SET role='super_admin',active=1 WHERE email=?").bind(email).run();
}
export async function handleAdminAuth(req,env,url){
 const p=url.pathname.replace(/^\/api/,"").replace(/\/+$/,"")||"/";
 if(p==="/admin/request-otp"&&req.method==="POST"){
  try{
   const b=await req.json(), email=emailOf(b.email), supreme=emailOf(env.SUPREME_ADMIN_EMAIL);
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:"A valid email is required"},400);
   if(!supreme)return json({error:"Set SUPREME_ADMIN_EMAIL before enabling admin sign-in"},503);
   if(email===supreme)await bootstrap(env,email);
   const user=await env.DB.prepare("SELECT id FROM admin_users WHERE email=? AND active=1").bind(email).first();
   if(!user)return json({message:"If this address is authorized, a sign-in code will be sent."});
   const recent=await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_otp_codes WHERE email=? AND created_at>datetime('now','-15 minutes')").bind(email).first();
   if(Number(recent?.n||0)>=3)return json({error:"Too many codes requested. Try again in 15 minutes."},429);
   const otp=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
   await env.DB.prepare("DELETE FROM admin_otp_codes WHERE email=?").bind(email).run();
   await env.DB.prepare("INSERT INTO admin_otp_codes(id,email,code_hash,expires_at) VALUES(?,?,?,datetime('now','+10 minutes'))").bind(uuid(),email,await hash(otp)).run();
   await sendOtp(env,email,otp);
   return json({message:"If this address is authorized, a sign-in code will be sent."});
  }catch(e){console.error("admin_otp_request_failed",e?.message||e);return json({error:"Unable to send sign-in code. Check email configuration."},503);}
 }
 if(p==="/admin/verify-otp"&&req.method==="POST"){
  try{
   const b=await req.json(),email=emailOf(b.email),otp=String(b.otp||"").trim();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^\d{6}$/.test(otp))return json({error:"Valid email and six-digit code are required"},400);
   const row=await env.DB.prepare("SELECT id,code_hash,attempts FROM admin_otp_codes WHERE email=? AND attempts<5 AND expires_at>CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1").bind(email).first();
   if(!row)return json({error:"Invalid or expired sign-in code"},401);
   if((await hash(otp))!==row.code_hash){await env.DB.prepare("UPDATE admin_otp_codes SET attempts=attempts+1 WHERE id=?").bind(row.id).run();return json({error:"Invalid or expired sign-in code"},401);}
   await env.DB.prepare("DELETE FROM admin_otp_codes WHERE email=?").bind(email).run();
   const u=await env.DB.prepare("SELECT id,email,display_name,role FROM admin_users WHERE email=? AND active=1").bind(email).first();
   if(!u)return json({error:"Administrator account is not active"},403);
   const token=hex(crypto.getRandomValues(new Uint8Array(32)));
   await env.DB.prepare("INSERT INTO admin_sessions(id,admin_id,token_hash,expires_at) VALUES(?,?,?,datetime('now','+12 hours'))").bind(uuid(),u.id,await hash(token)).run();
   return json({token,admin:{id:u.id,email:u.email,display_name:u.display_name,role:u.role}});
  }catch(e){console.error("admin_otp_verify_failed",e?.message||e);return json({error:"Unable to verify sign-in code"},500);}
 }
 return null;
}
export async function getAdminSession(req,env){
 const h=req.headers.get("Authorization")||"",token=h.startsWith("Bearer ")?h.slice(7).trim():"";
 if(token.length<32)return null;
 return await env.DB.prepare("SELECT u.id,u.email,u.display_name,u.role,s.id AS session_id FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP AND u.active=1").bind(await hash(token)).first();
}
export async function handleAdminSessionRoute(req,env,url,admin){
 const p=url.pathname.replace(/^\/api/,"").replace(/\/+$/,"")||"/";
 if(p==="/admin/me"&&req.method==="GET")return json({admin:{id:admin.id,email:admin.email,display_name:admin.display_name,role:admin.role}});
 if(p==="/admin/logout"&&req.method==="POST"){await env.DB.prepare("DELETE FROM admin_sessions WHERE id=?").bind(admin.session_id).run();return json({success:true});}
 if(p==="/admin/users"&&(req.method==="GET"||req.method==="POST")){
  if(admin.role!=="super_admin")return json({error:"Supreme Admin access required"},403);
  if(req.method==="GET"){const r=await env.DB.prepare("SELECT id,email,display_name,role,active,created_at FROM admin_users ORDER BY created_at DESC").all();return json({users:r.results||[]});}
  const b=await req.json(),email=emailOf(b.email),name=String(b.display_name||"").trim().slice(0,120);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:"A valid email is required"},400);
  await env.DB.prepare("INSERT INTO admin_users(id,email,display_name,role,active) VALUES(?,?,?,'admin',1) ON CONFLICT(email) DO UPDATE SET display_name=excluded.display_name,active=1").bind(uuid(),email,name||email).run();
  return json({success:true,email,role:"admin"},201);
 }
 return null;
}
