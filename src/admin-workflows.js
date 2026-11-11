import { getRequestAdmin } from './admin-auth.js';

const allowedOrigins = new Set([
  'https://signal-admin.whiteghostpheonix.workers.dev',
  'https://signal-dashboard.whiteghostpheonix.workers.dev',
  'http://localhost:5173',
  'http://localhost:3000',
]);

function json(data, status, origin) {
  const headers = {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://signal-admin.whiteghostpheonix.workers.dev',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
  return Response.json(data, { status, headers });
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function readBody(request) {
  try { return await request.json(); }
  catch { fail('Request body must be valid JSON'); }
}

async function audit(env, admin, action, type, entityId, details = {}) {
  try {
    await env.DB.prepare(`INSERT INTO admin_audit_log
      (id, admin_email, action, entity_type, entity_id, details_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), admin.email, action, type, entityId || null, JSON.stringify(details)).run();
  } catch (error) {
    console.error('Admin workflow audit write failed:', error?.message || error);
  }
}

export async function handleAdminWorkflowRoute(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  const origin = request.headers.get('Origin') || '';

  const isWorkflowPath = path.startsWith('/api/admin/customer-applications') ||
    path.startsWith('/api/admin/commissions') || path === '/api/admin/commission-settings';
  if (!isWorkflowPath) return null;

  const admin = await getRequestAdmin(request, env);
  if (!admin) return json({ error: 'Unauthorized' }, 401, origin);
  if (method === 'POST' && (path === '/api/admin/commission-settings' || path === '/api/admin/commissions/record')) {
    return json({ error: 'Payment-based retailer commissions are disabled. Configure commission by retailer, device and plan in Retailer Management.' }, 410, origin);
  }

  try {
    if (path === '/api/admin/customer-applications' && method === 'GET') {
      const status = url.searchParams.get('status') || '';
      if (status && !['pending', 'approved', 'rejected'].includes(status)) fail('Invalid application status filter');
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const result = status
        ? await env.DB.prepare('SELECT * FROM customer_applications WHERE status = ? ORDER BY created_at DESC LIMIT ?').bind(status, limit).all()
        : await env.DB.prepare('SELECT * FROM customer_applications ORDER BY created_at DESC LIMIT ?').bind(limit).all();
      return json({ applications: result.results || [] }, 200, origin);
    }

    const applicationMatch = path.match(/^\/api\/admin\/customer-applications\/([^/]+)$/);
    if (applicationMatch && method === 'GET') {
      const row = await env.DB.prepare('SELECT * FROM customer_applications WHERE id = ?').bind(decodeURIComponent(applicationMatch[1])).first();
      return row ? json({ application: row }, 200, origin) : json({ error: 'Customer application not found' }, 404, origin);
    }

    const decisionMatch = path.match(/^\/api\/admin\/customer-applications\/([^/]+)\/decision$/);
    if (decisionMatch && method === 'POST') {
      const applicationId = decodeURIComponent(decisionMatch[1]);
      const body = await readBody(request);
      const decision = String(body.decision || '').trim().toLowerCase();
      if (!['approve', 'reject'].includes(decision)) fail('Decision must be approve or reject');
      const reason = String(body.reason || '').trim().slice(0, 1000);
      if (decision === 'reject' && !reason) fail('A rejection reason is required');
      const current = await env.DB.prepare('SELECT id, status FROM customer_applications WHERE id = ?').bind(applicationId).first();
      if (!current) return json({ error: 'Customer application not found' }, 404, origin);
      if (current.status !== 'pending') return json({ error: 'Only pending applications can be reviewed', current_status: current.status }, 409, origin);
      const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
      const result = await env.DB.prepare(`UPDATE customer_applications
        SET status = ?, decision_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'`).bind(nextStatus, reason || null, admin.email, applicationId).run();
      if (!result.meta?.changes) return json({ error: 'Application was already reviewed' }, 409, origin);
      await audit(env, admin, `customer_application_${nextStatus}`, 'customer_application', applicationId, { reason });
      return json({ success: true, application_id: applicationId, status: nextStatus }, 200, origin);
    }

    if (path === '/api/admin/commission-settings' && method === 'GET') {
      const result = await env.DB.prepare('SELECT * FROM reseller_commission_settings ORDER BY reseller_id').all();
      return json({ settings: result.results || [] }, 200, origin);
    }

    if (path === '/api/admin/commission-settings' && method === 'POST') {
      const body = await readBody(request);
      const resellerId = String(body.reseller_id || '').trim();
      const rate = Number(body.rate_percent ?? 0);
      const fixed = Number(body.fixed_amount_ugx ?? 0);
      const appliesTo = body.applies_to || 'received_payment';
      if (!resellerId || resellerId.length > 128) fail('Select a valid retailer');
      if (!Number.isFinite(rate) || rate < 0 || rate > 100 || !Number.isSafeInteger(fixed) || fixed < 0) fail('Enter a valid commission rate and fixed amount');
      if (!['received_payment', 'device_sale'].includes(appliesTo)) fail('Invalid commission basis');
      const active = body.active === false ? 0 : 1;
      await env.DB.prepare(`INSERT INTO reseller_commission_settings
        (reseller_id, rate_percent, fixed_amount_ugx, applies_to, active, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(reseller_id) DO UPDATE SET rate_percent = excluded.rate_percent,
          fixed_amount_ugx = excluded.fixed_amount_ugx, applies_to = excluded.applies_to,
          active = excluded.active, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
        .bind(resellerId, rate, fixed, appliesTo, active, admin.email).run();
      await audit(env, admin, 'commission_settings_updated', 'reseller', resellerId, { rate_percent: rate, fixed_amount_ugx: fixed, applies_to: appliesTo, active });
      return json({ success: true, reseller_id: resellerId, rate_percent: rate, fixed_amount_ugx: fixed, applies_to: appliesTo, active }, 200, origin);
    }

    if (path === '/api/admin/commissions' && method === 'GET') {
      const status = url.searchParams.get('status') || '';
      if (status && !['pending', 'approved', 'paid', 'void'].includes(status)) fail('Invalid commission status filter');
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const result = status
        ? await env.DB.prepare('SELECT * FROM reseller_commissions WHERE status = ? ORDER BY created_at DESC LIMIT ?').bind(status, limit).all()
        : await env.DB.prepare('SELECT * FROM reseller_commissions ORDER BY created_at DESC LIMIT ?').bind(limit).all();
      return json({ commissions: result.results || [] }, 200, origin);
    }

    if (path === '/api/admin/commissions/record' && method === 'POST') {
      const body = await readBody(request);
      const resellerId = String(body.reseller_id || '').trim();
      const paymentReference = String(body.payment_reference || '').trim();
      const amount = Number(body.payment_amount_ugx);
      if (!resellerId || resellerId.length > 128) fail('Select a valid retailer');
      if (!paymentReference || paymentReference.length > 160) fail('Payment reference is required');
      if (!Number.isSafeInteger(amount) || amount <= 0) fail('Payment amount must be a positive whole number');
      const existing = await env.DB.prepare('SELECT id, commission_amount_ugx FROM reseller_commissions WHERE payment_reference = ?').bind(paymentReference).first();
      if (existing) return json({ success: true, duplicate: true, commission_id: existing.id, commission_amount_ugx: existing.commission_amount_ugx }, 200, origin);
      const settings = await env.DB.prepare('SELECT * FROM reseller_commission_settings WHERE reseller_id = ? AND active = 1').bind(resellerId).first();
      if (!settings) return json({ error: 'No active commission settings for this retailer' }, 404, origin);
      const commission = Math.round(amount * Number(settings.rate_percent) / 100 + Number(settings.fixed_amount_ugx));
      const commissionId = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO reseller_commissions
        (id, reseller_id, customer_application_id, payment_reference, payment_amount_ugx,
         rate_percent, fixed_amount_ugx, commission_amount_ugx)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(commissionId, resellerId, String(body.customer_application_id || '').trim() || null,
          paymentReference, amount, settings.rate_percent, settings.fixed_amount_ugx, commission).run();
      await audit(env, admin, 'commission_recorded', 'reseller_commission', commissionId, { reseller_id: resellerId, payment_reference: paymentReference, commission_amount_ugx: commission });
      return json({ success: true, commission_id: commissionId, commission_amount_ugx: commission }, 201, origin);
    }

    return json({ error: 'Admin workflow endpoint not found' }, 404, origin);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    console.error('Admin workflow request failed:', { path, method, message: error?.message || String(error) });
    return json({ error: status >= 500 ? 'The request could not be completed' : error.message }, status, origin);
  }
}
