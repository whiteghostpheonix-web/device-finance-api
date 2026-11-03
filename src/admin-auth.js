const ADMIN_EMAILS = new Set(['whiteghostpheonix@gmail.com']);
const OTP_TTL_MINUTES = 10;
const SESSION_TTL_HOURS = 8;

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
  const n = new DataView(randomBytes(4).buffer).getUint32(0) % 1000000;
  return String(n).padStart(6, '0');
}

function randomToken() {
  return [...randomBytes(32)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function otpDigest(env, email, otp) {
  if (!env.ADMIN_OTP_PEPPER) throw new Error('ADMIN_OTP_PEPPER is not configured');
  return sha256(`${env.ADMIN_OTP_PEPPER}:${email}:${otp}`);
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function response(data, status, origin) {
  return Response.json(data, {
    status,
    headers: {
      'Access-Control-Allow-Origin': origin || 'https://signal-dashboard.whiteghostpheonix.workers.dev',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
    },
  });
}

async function sendOtp(env, email, otp) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) throw new Error('Resend is not configured');
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
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

export async function getRequestAdmin(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await sha256(token);
  return env.DB.prepare(`
    SELECT a.id, a.email, a.display_name
    FROM admin_sessions s
    JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
      AND s.revoked_at IS NULL AND a.active = 1
    LIMIT 1
  `).bind(tokenHash).first();
}

export function isAdminProtectedPath(path, method) {
  if (path.startsWith('/api/dashboard/')) return true;
  if (path === '/api/plans' || path === '/api/resellers' || path === '/api/payments') return true;
  if (path.startsWith('/api/commands/')) return true;
  if (path === '/api/devices' && method !== 'GET') return true;
  if (path === '/api/customers' || path === '/api/assign-plan' || path === '/api/validate-nin') return true;
  return false;
}

export async function handleAdminRoute(request, env, origin) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/admin/request-otp' && request.method === 'POST') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response({ error: 'Enter a valid admin email address' }, 400, origin);
    }

    // Keep responses identical for unknown emails to avoid account enumeration.
    if (!ADMIN_EMAILS.has(email)) {
      return response({ ok: true, message: 'If this address is authorized, a sign-in code will be sent.' }, 200, origin);
    }

    try {
      const admin = await env.DB.prepare('SELECT id FROM admins WHERE email = ? AND active = 1').bind(email).first();
      if (!admin) return response({ ok: true, message: 'If this address is authorized, a sign-in code will be sent.' }, 200, origin);

      const recent = await env.DB.prepare(`
        SELECT COUNT(*) AS count FROM admin_otp_challenges
        WHERE admin_id = ? AND created_at > datetime('now', '-15 minutes')
      `).bind(admin.id).first();
      if (Number(recent?.count || 0) >= 3) {
        return response({ error: 'Too many codes requested. Wait 15 minutes and try again.' }, 429, origin);
      }

      const otp = randomOtp();
      const digest = await otpDigest(env, email, otp);
      await env.DB.prepare(`
        INSERT INTO admin_otp_challenges (id, admin_id, otp_hash, expires_at)
        VALUES (?, ?, ?, datetime('now', '+${OTP_TTL_MINUTES} minutes'))
      `).bind(crypto.randomUUID(), admin.id, digest).run();
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
    if (!ADMIN_EMAILS.has(email) || !/^\d{6}$/.test(otp)) {
      return response({ error: 'Invalid or expired code' }, 401, origin);
    }

    const admin = await env.DB.prepare('SELECT id, email, display_name FROM admins WHERE email = ? AND active = 1').bind(email).first();
    if (!admin) return response({ error: 'Invalid or expired code' }, 401, origin);
    const challenge = await env.DB.prepare(`
      SELECT id, otp_hash, attempts FROM admin_otp_challenges
      WHERE admin_id = ? AND consumed_at IS NULL AND expires_at > datetime('now')
      ORDER BY created_at DESC LIMIT 1
    `).bind(admin.id).first();
    if (!challenge || Number(challenge.attempts) >= 5) return response({ error: 'Invalid or expired code' }, 401, origin);

    const digest = await otpDigest(env, email, otp);
    if (digest !== challenge.otp_hash) {
      await env.DB.prepare('UPDATE admin_otp_challenges SET attempts = attempts + 1 WHERE id = ?').bind(challenge.id).run();
      return response({ error: 'Invalid or expired code' }, 401, origin);
    }

    await env.DB.prepare('UPDATE admin_otp_challenges SET consumed_at = datetime(\'now\') WHERE id = ?').bind(challenge.id).run();
    const token = randomToken();
    const tokenHash = await sha256(token);
    await env.DB.prepare(`
      INSERT INTO admin_sessions (token_hash, admin_id, expires_at)
      VALUES (?, ?, datetime('now', '+${SESSION_TTL_HOURS} hours'))
    `).bind(tokenHash, admin.id).run();
    return response({ ok: true, token, admin }, 200, origin);
  }

  if (path === '/api/admin/me' && request.method === 'GET') {
    const admin = await getRequestAdmin(request, env);
    if (!admin) return response({ error: 'Unauthorized' }, 401, origin);
    return response({ admin }, 200, origin);
  }

  if (path === '/api/admin/logout' && request.method === 'POST') {
    const authorization = request.headers.get('Authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      await env.DB.prepare('UPDATE admin_sessions SET revoked_at = datetime(\'now\') WHERE token_hash = ?').bind(await sha256(token)).run();
    }
    return response({ ok: true }, 200, origin);
  }

  if (path === '/api/admin/users' && request.method === 'GET') {
    const actor = await getRequestAdmin(request, env);
    if (!actor) return response({ error: 'Unauthorized' }, 401, origin);
    const rows = await env.DB.prepare('SELECT id, email, display_name, active, created_at FROM admins ORDER BY created_at').all();
    return response({ users: rows.results || [] }, 200, origin);
  }

  if (path === '/api/admin/users' && request.method === 'POST') {
    const actor = await getRequestAdmin(request, env);
    if (!actor) return response({ error: 'Unauthorized' }, 401, origin);
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
