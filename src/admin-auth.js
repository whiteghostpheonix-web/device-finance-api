const DEFAULT_ADMIN_EMAIL = 'whiteghostpheonix@gmail.com';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, x-admin-token, CF-Access-Client-Id, CF-Access-Client-Secret',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, origin = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      'content-type': 'application/json',
    },
  });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function makeToken() {
  return crypto.randomUUID();
}

export async function ensureAdminTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_otp_challenges (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins(id)
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      FOREIGN KEY (admin_id) REFERENCES admins(id)
    )
  `).run();

  const email = DEFAULT_ADMIN_EMAIL.toLowerCase();
  const existing = await env.DB.prepare('SELECT id FROM admins WHERE email = ?').bind(email).first();
  if (!existing) {
    await env.DB.prepare('INSERT INTO admins (id, email, display_name, active) VALUES (?, ?, ?, 1)').bind(
      crypto.randomUUID(),
      email,
      'Primary Admin',
    ).run();
  }
}

async function getAdminByEmail(env, email) {
  return env.DB.prepare('SELECT * FROM admins WHERE email = ?').bind(normalizeEmail(email)).first();
}

async function getRequestAdmin(request, env) {
  const auth = request.headers.get('Authorization');
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : request.headers.get('x-admin-token');

  if (token) {
    const tokenHash = await sha256Hex(token);
    const row = await env.DB.prepare(`
      SELECT a.*
      FROM admin_sessions s
      JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND s.revoked_at IS NULL
    `).bind(tokenHash).first();
    return row || null;
  }

  const emailHeader = request.headers.get('cf-access-authenticated-user-email');
  if (emailHeader) {
    const admin = await getAdminByEmail(env, emailHeader);
    return admin || null;
  }

  return null;
}

async function storeOtp(env, adminId, otp) {
  const id = crypto.randomUUID();
  const otpHash = await sha256Hex(String(otp));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO admin_otp_challenges (id, admin_id, otp_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).bind(id, adminId, otpHash, expiresAt).run();
  return { id, expiresAt };
}

async function sendOtpEmail(env, email, otp) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY is missing; OTP email not sent.');
    return false;
  }
  const from = env.RESEND_FROM || 'Signal Admin <noreply@signal-finance.app>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Your admin login code',
      html: `<p>Your admin login code is <strong>${otp}</strong>.</p><p>This code expires in 10 minutes.</p>`,
    }),
  });
  if (!response.ok) {
    console.warn('Resend email failed:', await response.text());
    return false;
  }
  return true;
}

async function issueSession(env, adminId) {
  const token = makeToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO admin_sessions (token_hash, admin_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(tokenHash, adminId, expiresAt).run();
  return token;
}

function parseJsonBody(request) {
  return request.text().then((text) => {
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
  });
}

export async function handleAdminRoute({ request, env, origin }) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/admin/request-otp' && request.method === 'POST') {
    const body = await parseJsonBody(request);
    const email = normalizeEmail(body.email || '');
    if (!email) return jsonResponse({ error: 'Email required' }, 400, origin);

    const admin = await getAdminByEmail(env, email);
    if (!admin || admin.active === 0) {
      return jsonResponse({ error: 'Admin account not found' }, 404, origin);
    }

    const otp = generateOtp();
    await storeOtp(env, admin.id, otp);
    await sendOtpEmail(env, email, otp);

    return jsonResponse({ ok: true, message: 'OTP sent to email' }, 200, origin);
  }

  if (path === '/api/admin/verify-otp' && request.method === 'POST') {
    const body = await parseJsonBody(request);
    const email = normalizeEmail(body.email || '');
    const otp = String(body.otp || '');
    if (!email || !otp) return jsonResponse({ error: 'Email and OTP are required' }, 400, origin);

    const admin = await getAdminByEmail(env, email);
    if (!admin || admin.active === 0) return jsonResponse({ error: 'Admin account not found' }, 404, origin);

    const challenge = await env.DB.prepare(`
      SELECT * FROM admin_otp_challenges
      WHERE admin_id = ? AND expires_at > datetime('now')
      ORDER BY created_at DESC LIMIT 1
    `).bind(admin.id).first();

    if (!challenge) return jsonResponse({ error: 'No active OTP challenge' }, 401, origin);
    const challengeHash = await sha256Hex(otp);
    if (challenge.otp_hash !== challengeHash) {
      await env.DB.prepare('UPDATE admin_otp_challenges SET attempts = attempts + 1 WHERE id = ?').bind(challenge.id).run();
      return jsonResponse({ error: 'Invalid OTP' }, 401, origin);
    }

    await env.DB.prepare('UPDATE admin_otp_challenges SET consumed_at = datetime("now") WHERE id = ?').bind(challenge.id).run();
    const token = await issueSession(env, admin.id);
    return jsonResponse({ ok: true, token, admin: { id: admin.id, email: admin.email, display_name: admin.display_name } }, 200, origin);
  }

  if (path === '/api/admin/me' && request.method === 'GET') {
    const admin = await getRequestAdmin(request, env);
    if (!admin) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
    return jsonResponse({ admin: { id: admin.id, email: admin.email, display_name: admin.display_name } }, 200, origin);
  }

  if (path === '/api/admin/logout' && request.method === 'POST') {
    const token = request.headers.get('Authorization')?.startsWith('Bearer ') ? request.headers.get('Authorization').slice(7).trim() : request.headers.get('x-admin-token');
    if (token) {
      const tokenHash = await sha256Hex(token);
      await env.DB.prepare('UPDATE admin_sessions SET revoked_at = datetime("now") WHERE token_hash = ?').bind(tokenHash).run();
    }
    return jsonResponse({ ok: true }, 200, origin);
  }

  if (path === '/api/admin/users' && request.method === 'GET') {
    const admin = await getRequestAdmin(request, env);
    if (!admin) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
    const rows = await env.DB.prepare('SELECT id, email, display_name, active, created_at FROM admins ORDER BY created_at DESC').all();
    return jsonResponse({ users: rows.results || [] }, 200, origin);
  }

  if (path === '/api/admin/users' && request.method === 'POST') {
    const admin = await getRequestAdmin(request, env);
    if (!admin) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
    const body = await parseJsonBody(request);
    const email = normalizeEmail(body.email || '');
    const displayName = String(body.display_name || body.name || email.split('@')[0]);
    if (!email) return jsonResponse({ error: 'Email required' }, 400, origin);
    const exists = await getAdminByEmail(env, email);
    if (exists) return jsonResponse({ error: 'Admin already exists' }, 409, origin);
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO admins (id, email, display_name, active) VALUES (?, ?, ?, 1)').bind(id, email, displayName).run();
    return jsonResponse({ ok: true, admin: { id, email, display_name: displayName } }, 200, origin);
  }

  if (path.startsWith('/api/dashboard/') && request.method === 'GET') {
    const admin = await getRequestAdmin(request, env);
    if (!admin) return jsonResponse({ error: 'Unauthorized' }, 401, origin);
  }

  return null;
}
