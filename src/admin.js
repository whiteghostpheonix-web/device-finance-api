const json = (data, status = 200) => Response.json(data, {
  status,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret',
    'Cache-Control': 'no-store',
  },
});

const id = () => crypto.randomUUID();

async function audit(env, admin, action, entityType, entityId, details = {}) {
  try {
    await env.DB.prepare(`
      INSERT INTO admin_audit_log
        (id, admin_email, action, entity_type, entity_id, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id(), admin, action, entityType, entityId || null, JSON.stringify(details)).run();
  } catch (error) {
    console.error('admin_audit_write_failed', error?.message || error);
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.status = 400;
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function requireString(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(field + ' is required');
    error.status = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  const result = value.trim();
  if (result.length > max) {
    const error = new Error(field + ' is too long');
    error.status = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  return result;
}

async function handle(request, env, url, admin) {
  const path = url.pathname.replace(/\\/+$/, '') || '/';
  const method = request.method;

  if (path === '/admin/customer-applications' && method === 'POST') {
    const body = await readJson(request);
    const customerName = requireString(body.customer_name, 'customer_name');
    const customerPhone = requireString(body.customer_phone, 'customer_phone', 30);
    const applicationId = id();
    await env.DB.prepare(`
      INSERT INTO customer_applications
        (id, reseller_id, customer_name, customer_phone, customer_email, nin,
         occupation, monthly_income_ugx, guarantor_json, device_json,
         finance_plan_json, kyc_media_json, deposit_amount_ugx)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      applicationId,
      body.reseller_id || null,
      customerName,
      customerPhone,
      body.customer_email || null,
      body.nin || null,
      body.occupation || null,
      Number.isFinite(Number(body.monthly_income_ugx)) ? Math.max(0, Math.round(Number(body.monthly_income_ugx))) : null,
      body.guarantor ? JSON.stringify(body.guarantor) : null,
      body.device ? JSON.stringify(body.device) : null,
      body.finance_plan ? JSON.stringify(body.finance_plan) : null,
      body.kyc_media ? JSON.stringify(body.kyc_media) : null,
      Math.max(0, Math.round(Number(body.deposit_amount_ugx) || 0))
    ).run();
    await audit(env, admin, 'customer_application_created', 'customer_application', applicationId);
    return json({ success: true, application_id: applicationId, status: 'pending' }, 201);
  }

  if (path === '/admin/customer-applications' && method === 'GET') {
    const status = url.searchParams.get('status');
    const allowed = ['pending', 'approved', 'rejected'];
    if (status && !allowed.includes(status)) {
      return json({ error: 'Invalid status filter', code: 'VALIDATION_ERROR' }, 400);
    }
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const result = status
      ? await env.DB.prepare('SELECT * FROM customer_applications WHERE status = ? ORDER BY created_at DESC LIMIT ?').bind(status, limit).all()
      : await env.DB.prepare('SELECT * FROM customer_applications ORDER BY created_at DESC LIMIT ?').bind(limit).all();
    return json({ applications: result.results || [] });
  }

  const applicationMatch = path.match(/^\\/admin\\/customer-applications\\/([^/]+)$/);
  if (applicationMatch && method === 'GET') {
    const application = await env.DB.prepare('SELECT * FROM customer_applications WHERE id = ?').bind(decodeURIComponent(applicationMatch[1])).first();
    if (!application) return json({ error: 'Customer application not found', code: 'NOT_FOUND' }, 404);
    return json({ application });
  }

  const decisionMatch = path.match(/^\\/admin\\/customer-applications\\/([^/]+)\\/decision$/);
  if (decisionMatch && method === 'POST') {
    const applicationId = decodeURIComponent(decisionMatch[1]);
    const body = await readJson(request);
    const decision = requireString(body.decision, 'decision', 20).toLowerCase();
    if (!['approve', 'reject'].includes(decision)) {
      return json({ error: 'decision must be approve or reject', code: 'VALIDATION_ERROR' }, 400);
    }
    const reason = decision === 'reject' ? requireString(body.reason, 'reason', 1000) : (String(body.reason || '').slice(0, 1000));
    const current = await env.DB.prepare('SELECT id, status FROM customer_applications WHERE id = ?').bind(applicationId).first();
    if (!current) return json({ error: 'Customer application not found', code: 'NOT_FOUND' }, 404);
    if (current.status !== 'pending') {
      return json({ error: 'Only pending applications can be reviewed', code: 'CONFLICT', current_status: current.status }, 409);
    }
    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
    const result = await env.DB.prepare(`
      UPDATE customer_applications
      SET status = ?, decision_reason = ?, reviewed_by = ?,
          reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
    `).bind(nextStatus, reason || null, admin, applicationId).run();
    if (!result.meta?.changes) return json({ error: 'Application was already reviewed', code: 'CONFLICT' }, 409);
    await audit(env, admin, 'customer_application_' + nextStatus, 'customer_application', applicationId, { reason });
    return json({ success: true, application_id: applicationId, status: nextStatus });
  }

  if (path === '/admin/commission-settings' && method === 'POST') {
    const body = await readJson(request);
    const resellerId = requireString(body.reseller_id, 'reseller_id', 128);
    const rate = Number(body.rate_percent ?? 0);
    const fixed = Math.round(Number(body.fixed_amount_ugx ?? 0));
    const appliesTo = body.applies_to || 'received_payment';
    if (!Number.isFinite(rate) || rate < 0 || rate > 100 || !Number.isFinite(fixed) || fixed < 0 ||
        !['received_payment', 'device_sale'].includes(appliesTo)) {
      return json({ error: 'Invalid commission settings', code: 'VALIDATION_ERROR' }, 400);
    }
    await env.DB.prepare(`
      INSERT INTO reseller_commission_settings
        (reseller_id, rate_percent, fixed_amount_ugx, applies_to, active, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(reseller_id) DO UPDATE SET
        rate_percent = excluded.rate_percent,
        fixed_amount_ugx = excluded.fixed_amount_ugx,
        applies_to = excluded.applies_to,
        active = excluded.active,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).bind(resellerId, rate, fixed, appliesTo, body.active === false ? 0 : 1, admin).run();
    await audit(env, admin, 'commission_settings_updated', 'reseller', resellerId, { rate_percent: rate, fixed_amount_ugx: fixed, applies_to: appliesTo });
    return json({ success: true, reseller_id: resellerId, rate_percent: rate, fixed_amount_ugx: fixed, applies_to: appliesTo });
  }

  if (path === '/admin/commissions' && method === 'GET') {
    const status = url.searchParams.get('status');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const result = status
      ? await env.DB.prepare('SELECT * FROM reseller_commissions WHERE status = ? ORDER BY created_at DESC LIMIT ?').bind(status, limit).all()
      : await env.DB.prepare('SELECT * FROM reseller_commissions ORDER BY created_at DESC LIMIT ?').bind(limit).all();
    return json({ commissions: result.results || [] });
  }

  if (path === '/admin/commissions/record' && method === 'POST') {
    const body = await readJson(request);
    const resellerId = requireString(body.reseller_id, 'reseller_id', 128);
    const paymentReference = requireString(body.payment_reference, 'payment_reference', 160);
    const amount = Math.round(Number(body.payment_amount_ugx));
    if (!Number.isSafeInteger(amount) || amount <= 0) return json({ error: 'payment_amount_ugx must be a positive integer', code: 'VALIDATION_ERROR' }, 400);
    const existing = await env.DB.prepare('SELECT id FROM reseller_commissions WHERE payment_reference = ?').bind(paymentReference).first();
    if (existing) return json({ success: true, duplicate: true, commission_id: existing.id });
    const settings = await env.DB.prepare('SELECT * FROM reseller_commission_settings WHERE reseller_id = ? AND active = 1').bind(resellerId).first();
    if (!settings) return json({ error: 'No active commission settings for reseller', code: 'NOT_FOUND' }, 404);
    const commission = Math.round(amount * Number(settings.rate_percent) / 100 + Number(settings.fixed_amount_ugx));
    const commissionId = id();
    await env.DB.prepare(`
      INSERT INTO reseller_commissions
        (id, reseller_id, customer_application_id, payment_reference,
         payment_amount_ugx, rate_percent, fixed_amount_ugx, commission_amount_ugx)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(commissionId, resellerId, body.customer_application_id || null, paymentReference, amount, settings.rate_percent, settings.fixed_amount_ugx, commission).run();
    await audit(env, admin, 'commission_recorded', 'reseller_commission', commissionId, { reseller_id: resellerId, payment_reference: paymentReference, commission_amount_ugx: commission });
    return json({ success: true, commission_id: commissionId, commission_amount_ugx: commission }, 201);
  }

  return json({ error: 'Admin endpoint not found', code: 'NOT_FOUND' }, 404);
}

export async function handleAdminRequest(request, env, url) {
  const configured = String(env.ADMIN_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const email = (request.headers.get('cf-access-authenticated-user-email') || '').trim().toLowerCase();

  if (!configured.length) {
    return json({ error: 'Admin API is not configured. Set ADMIN_EMAILS and protect this Worker with Cloudflare Access.', code: 'ADMIN_NOT_CONFIGURED' }, 503);
  }
  if (!email || !configured.includes(email)) {
    return json({ error: 'Administrator access required', code: 'UNAUTHORIZED' }, 401);
  }

  try {
    return await handle(request, env, url, email);
  } catch (error) {
    const errorId = id();
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const safeMessage = status >= 500 ? 'The request could not be completed' : (error.message || 'Invalid request');
    console.error('admin_api_error', { errorId, route: url.pathname, method: request.method, message: error?.message, stack: error?.stack });
    try {
      await env.DB.prepare(`
        INSERT INTO admin_api_errors (id, route, method, error_code, message, admin_email)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(errorId, url.pathname, request.method, error?.code || 'INTERNAL_ERROR', String(error?.message || 'Unknown error').slice(0, 500), email).run();
    } catch (logError) {
      console.error('admin_error_log_failed', logError?.message || logError);
    }
    return json({ error: safeMessage, code: error?.code || 'INTERNAL_ERROR', error_id: errorId }, status);
  }
}
