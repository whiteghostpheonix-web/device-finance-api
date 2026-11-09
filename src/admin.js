const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret',
};

const response = (data, status = 200) => Response.json(data, { status, headers });
const fail = (message, status = 400, code = 'BAD_REQUEST') =>
  response({ success: false, error: { code, message } }, status);

function getAdminEmail(request, env) {
  const email = (request.headers.get('cf-access-authenticated-user-email') || '').trim().toLowerCase();
  const allowed = String(env.ADMIN_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  return email && allowed.includes(email) ? email : null;
}

async function tableColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info("${table}")`).all();
  return new Set((result.results || []).map(column => column.name));
}

async function audit(db, entity, entityId, action, details) {
  try {
    await db.prepare(
      'INSERT INTO audit_log (entity, entity_id, action, details) VALUES (?, ?, ?, ?)'
    ).bind(entity, String(entityId), action, JSON.stringify(details || {})).run();
  } catch (error) {
    console.error('Admin audit write failed:', error?.message || error);
  }
}

async function readJson(request) {
  try { return await request.json(); }
  catch { throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 }); }
}

export async function handleAdminApi(request, env, url) {
  const path = url.pathname;
  if (!path.startsWith('/admin/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (!env.DB) return fail('Database binding DB is unavailable', 503, 'DATABASE_UNAVAILABLE');

  const admin = getAdminEmail(request, env);
  if (!admin) return fail('Admin authentication required', 401, 'UNAUTHORIZED');

  try {
    if (path === '/admin/customers' && request.method === 'GET') {
      const columns = await tableColumns(env.DB, 'customers');
      if (!columns.size) return fail('Customers table is not installed. Apply the additive D1 migration first.', 503, 'SCHEMA_NOT_READY');
      const rows = await env.DB.prepare('SELECT * FROM customers ORDER BY id DESC LIMIT 250').all();
      return response({ success: true, customers: rows.results || [] });
    }

    const decisionMatch = path.match(/^\/admin\/customers\/([^/]+)\/(approve|reject)$/);
    if (decisionMatch && request.method === 'POST') {
      const customerId = decodeURIComponent(decisionMatch[1]);
      const decision = decisionMatch[2] === 'approve' ? 'approved' : 'rejected';
      const body = await readJson(request);
      const reason = String(body.reason || '').trim().slice(0, 1000);
      const columns = await tableColumns(env.DB, 'customers');
      if (!columns.size) return fail('Customers table is not installed.', 503, 'SCHEMA_NOT_READY');
      const idColumn = columns.has('id') ? 'id' : columns.has('customer_id') ? 'customer_id' : null;
      if (!idColumn) return fail('Customers table has no supported identifier column.', 503, 'SCHEMA_MISMATCH');
      if (decision === 'rejected' && !reason) return fail('A rejection reason is required.', 422, 'REASON_REQUIRED');
      const customer = await env.DB.prepare(`SELECT * FROM customers WHERE "${idColumn}" = ?`).bind(customerId).first();
      if (!customer) return fail('Customer not found.', 404, 'NOT_FOUND');
      if (columns.has('kyc_status')) {
        await env.DB.prepare(`UPDATE customers SET kyc_status = ? WHERE "${idColumn}" = ?`).bind(decision, customerId).run();
      } else if (columns.has('status')) {
        await env.DB.prepare(`UPDATE customers SET status = ? WHERE "${idColumn}" = ?`).bind(decision, customerId).run();
      } else {
        return fail('Customers table has no kyc_status or status column; add the relevant column before approvals.', 503, 'SCHEMA_MISMATCH');
      }
      await env.DB.prepare(
        'INSERT INTO admin_customer_reviews (customer_id, decision, reason, reviewed_by) VALUES (?, ?, ?, ?)'
      ).bind(customerId, decision, reason || null, admin).run();
      await audit(env.DB, 'customer', customerId, decision, { reason, reviewed_by: admin });
      return response({ success: true, customer_id: customerId, status: decision });
    }

    if (path === '/admin/commissions/settings' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT * FROM reseller_commission_settings ORDER BY reseller_id'
      ).all();
      return response({ success: true, settings: rows.results || [] });
    }

    const settingsMatch = path.match(/^\/admin\/commissions\/settings\/([^/]+)$/);
    if (settingsMatch && request.method === 'PUT') {
      const resellerId = decodeURIComponent(settingsMatch[1]);
      const body = await readJson(request);
      const rate = Number(body.rate_percent ?? 0);
      const fixed = Number(body.fixed_amount_ugx ?? 0);
      const enabled = body.enabled === false ? 0 : 1;
      if (!resellerId || !Number.isFinite(rate) || rate < 0 || rate > 100 ||
          !Number.isFinite(fixed) || fixed < 0) {
        return fail('Provide a valid reseller ID, rate (0–100), and non-negative fixed amount.');
      }
      await env.DB.prepare(`
        INSERT INTO reseller_commission_settings
          (reseller_id, rate_percent, fixed_amount_ugx, enabled, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(reseller_id) DO UPDATE SET
          rate_percent=excluded.rate_percent,
          fixed_amount_ugx=excluded.fixed_amount_ugx,
          enabled=excluded.enabled,
          updated_by=excluded.updated_by,
          updated_at=CURRENT_TIMESTAMP
      `).bind(resellerId, rate, fixed, enabled, admin).run();
      await audit(env.DB, 'reseller', resellerId, 'commission_settings_updated', { rate, fixed, enabled, admin });
      return response({ success: true, reseller_id: resellerId, rate_percent: rate, fixed_amount_ugx: fixed, enabled: !!enabled });
    }

    if (path === '/admin/commissions' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT * FROM reseller_commissions ORDER BY created_at DESC LIMIT 500'
      ).all();
      return response({ success: true, commissions: rows.results || [] });
    }

    if (path === '/admin/commissions/accrue' && request.method === 'POST') {
      const body = await readJson(request);
      const resellerId = String(body.reseller_id || '').trim();
      const transactionId = String(body.transaction_id || '').trim();
      if (!resellerId || !transactionId) return fail('reseller_id and transaction_id are required.');
      const transaction = await env.DB.prepare(
        'SELECT id, amount_ugx FROM transactions WHERE CAST(id AS TEXT) = ?'
      ).bind(transactionId).first();
      if (!transaction) return fail('Transaction not found.', 404, 'TRANSACTION_NOT_FOUND');
      const setting = await env.DB.prepare(
        'SELECT * FROM reseller_commission_settings WHERE reseller_id = ?'
      ).bind(resellerId).first();
      if (!setting || !setting.enabled) return fail('Commission is not enabled for this reseller.', 409, 'COMMISSION_DISABLED');
      const gross = Number(transaction.amount_ugx);
      const commission = Math.round(gross * Number(setting.rate_percent) / 100 + Number(setting.fixed_amount_ugx));
      if (!Number.isFinite(gross) || gross <= 0 || commission < 0) return fail('Transaction amount is invalid.', 422, 'INVALID_AMOUNT');
      try {
        const inserted = await env.DB.prepare(`
          INSERT INTO reseller_commissions
            (reseller_id, transaction_id, gross_amount_ugx, commission_amount_ugx, rate_percent)
          VALUES (?, ?, ?, ?, ?)
        `).bind(resellerId, transactionId, gross, commission, setting.rate_percent).run();
        await audit(env.DB, 'commission', inserted.meta.last_row_id, 'accrued', { resellerId, transactionId, gross, commission, admin });
        return response({ success: true, commission_id: inserted.meta.last_row_id, commission_amount_ugx: commission });
      } catch (error) {
        if (/UNIQUE constraint failed/i.test(error?.message || '')) {
          return fail('A commission has already been recorded for this transaction.', 409, 'DUPLICATE_COMMISSION');
        }
        throw error;
      }
    }

    return fail('Admin endpoint not found.', 404, 'NOT_FOUND');
  } catch (error) {
    const status = Number(error?.status) || 500;
    const requestId = crypto.randomUUID();
    console.error('Admin API error', { requestId, path, message: error?.message || String(error) });
    return response({
      success: false,
      error: {
        code: status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
        message: status >= 500 ? 'The request could not be completed. Please retry or contact support.' : error.message,
        request_id: requestId,
      },
    }, status);
  }
}
