const OTP_TTL_MINUTES = 10;
const SESSION_TTL_HOURS = 8;
const INITIAL_ADMIN_EMAIL = 'whiteghostpheonix@gmail.com';
const ALLOWED_ORIGINS = new Set([
  'https://signal-admin.whiteghostpheonix.workers.dev',
  'http://localhost:5173',
  'http://localhost:3000',
]);

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomOtp() {
  return String(new DataView(randomBytes(4).buffer).getUint32(0) % 1000000).padStart(6, '0');
}

function randomToken() {
  return [...randomBytes(32)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function otpDigest(env, email, otp) {
  if (!env.ADMIN_OTP_PEPPER) throw new Error('ADMIN_OTP_PEPPER is not configured');
  return sha256(`${env.ADMIN_OTP_PEPPER}:${email}:${otp}`);
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function response(data, status, requestOrigin) {
  const origin = ALLOWED_ORIGINS.has(requestOrigin)
    ? requestOrigin
    : 'https://signal-admin.whiteghostpheonix.workers.dev';
  return Response.json(data, {
    status,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
    },
  });
}

export async function ensureAdminTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_otp_challenges (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    otp_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admins(id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT,
    FOREIGN KEY (admin_id) REFERENCES admins(id)
  )`).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO admins (id, email, display_name, active)
    VALUES ('primary-admin', ?, 'Primary Admin', 1)`).bind(INITIAL_ADMIN_EMAIL).run();
}

export async function getRequestAdmin(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return env.DB.prepare(`
    SELECT a.id, a.email, a.display_name
    FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
      AND s.revoked_at IS NULL AND a.active = 1 LIMIT 1
  `).bind(await sha256(token)).first();
}

export function isAdminProtectedPath(path, method) {
  if (path.startsWith('/api/dashboard/')) return true;
  if (path === '/api/plans' || path.startsWith('/api/plans/')) return true;
  if (path === '/api/resellers' || path.startsWith('/api/resellers/')) return true;
  if (path === '/api/payments' || path.startsWith('/api/payments/')) return true;
  if (path.startsWith('/api/commands/')) return true;
  if (path === '/api/devices' || path.startsWith('/api/devices/')) return true;
  if (path === '/api/customers' || path.startsWith('/api/customers/')) return true;
  if (path.startsWith('/api/reports/')) return true;
  if (path === '/api/assign-plan' || path === '/api/validate-nin') return true;
  return false;
}

async function sendOtp(env, email, otp) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) throw new Error('Resend is not configured');
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [email],
      subject: 'Your Signal admin sign-in code',
      text: `Your Signal admin sign-in code is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes. If you did not request it, ignore this email.`,
    }),
  });
  if (!result.ok) {
    console.error('Resend rejected admin OTP email', result.status);
    throw new Error('OTP email could not be sent');
  }
}

export async function handleAdminRoute(request, env) {
  const origin = request.headers.get('Origin') || '';
  const path = new URL(request.url).pathname;
  if (path === '/api/admin/request-otp' && request.method === 'POST') {
    const { email: rawEmail } = await readJson(request);
    const email = normalizeEmail(rawEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response({ error: 'Enter a valid admin email address' }, 400, origin);
    try {
      const admin = await env.DB.prepare('SELECT id FROM admins WHERE email = ? AND active = 1').bind(email).first();
      if (!admin) return response({ ok: true, message: 'If this address is authorized, a sign-in code will be sent.' }, 200, origin);
      const recent = await env.DB.prepare(`SELECT COUNT(*) AS count FROM admin_otp_challenges
        WHERE admin_id = ? AND created_at > datetime('now', '-15 minutes')`).bind(admin.id).first();
      if (Number(recent?.count || 0) >= 3) return response({ error: 'Too many codes requested. Wait 15 minutes and try again.' }, 429, origin);
      const otp = randomOtp();
      await env.DB.prepare(`INSERT INTO admin_otp_challenges (id, admin_id, otp_hash, expires_at)
        VALUES (?, ?, ?, datetime('now', '+${OTP_TTL_MINUTES} minutes'))`)
        .bind(crypto.randomUUID(), admin.id, await otpDigest(env, email, otp)).run();
      await sendOtp(env, email, otp);
      return response({ ok: true, message: 'If this address is authorized, a sign-in code will be sent.' }, 200, origin);
    } catch (error) {
      console.error('Admin OTP request failed:', error.message);
      return response({ error: 'Unable to send a sign-in code right now. Check server configuration.' }, 503, origin);
    }
  }
  if (path === '/api/admin/verify-otp' && request.method === 'POST') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const otp = String(body.otp || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(otp)) return response({ error: 'Invalid or expired code' }, 401, origin);
    const admin = await env.DB.prepare('SELECT id, email, display_name FROM admins WHERE email = ? AND active = 1').bind(email).first();
    if (!admin) return response({ error: 'Invalid or expired code' }, 401, origin);
    const challenge = await env.DB.prepare(`SELECT id, otp_hash, attempts FROM admin_otp_challenges
      WHERE admin_id = ? AND consumed_at IS NULL AND expires_at > datetime('now')
      ORDER BY created_at DESC LIMIT 1`).bind(admin.id).first();
    if (!challenge || Number(challenge.attempts) >= 5) return response({ error: 'Invalid or expired code' }, 401, origin);
    if (await otpDigest(env, email, otp) !== challenge.otp_hash) {
      await env.DB.prepare('UPDATE admin_otp_challenges SET attempts = attempts + 1 WHERE id = ?').bind(challenge.id).run();
      return response({ error: 'Invalid or expired code' }, 401, origin);
    }
    await env.DB.prepare("UPDATE admin_otp_challenges SET consumed_at = datetime('now') WHERE id = ?").bind(challenge.id).run();
    const token = randomToken();
    await env.DB.prepare(`INSERT INTO admin_sessions (token_hash, admin_id, expires_at)
      VALUES (?, ?, datetime('now', '+${SESSION_TTL_HOURS} hours'))`).bind(await sha256(token), admin.id).run();
    return response({ ok: true, token, admin }, 200, origin);
  }
  if (path === '/api/admin/me' && request.method === 'GET') {
    const admin = await getRequestAdmin(request, env);
    return admin ? response({ admin }, 200, origin) : response({ error: 'Unauthorized' }, 401, origin);
  }
  if (path === '/api/admin/logout' && request.method === 'POST') {
    const authorization = request.headers.get('Authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (/^[a-f0-9]{64}$/.test(token)) await env.DB.prepare("UPDATE admin_sessions SET revoked_at = datetime('now') WHERE token_hash = ?").bind(await sha256(token)).run();
    return response({ ok: true }, 200, origin);
  }
  if (path === '/api/admin/users' && request.method === 'GET') {
    if (!await getRequestAdmin(request, env)) return response({ error: 'Unauthorized' }, 401, origin);
    const result = await env.DB.prepare('SELECT id, email, display_name, active, created_at FROM admins ORDER BY created_at').all();
    return response({ users: result.results || [] }, 200, origin);
  }
  if (path === '/api/admin/users' && request.method === 'POST') {
    if (!await getRequestAdmin(request, env)) return response({ error: 'Unauthorized' }, 401, origin);
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const displayName = String(body.display_name || email.split('@')[0]).trim().slice(0, 100);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response({ error: 'Enter a valid email address' }, 400, origin);
    try {
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO admins (id, email, display_name, active) VALUES (?, ?, ?, 1)').bind(id, email, displayName).run();
      return response({ ok: true, admin: { id, email, display_name: displayName, active: 1 } }, 201, origin);
    } catch {
      return response({ error: 'Admin already exists or could not be added' }, 409, origin);
    }
  }
  return null;
}
