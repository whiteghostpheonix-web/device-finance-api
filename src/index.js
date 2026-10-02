import { sendFcm } from './fcm.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret',
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: corsHeaders });
}

function getResellerEmail(request) {
  return request.headers.get('cf-access-authenticated-user-email') || null;
}

function validateUgandaNIN(nin) {
  if (!nin || typeof nin !== 'string') return { valid: false, reason: 'NIN is required' };
  const trimmed = nin.trim().toUpperCase();
  if (!/^(CM|CF)[A-Z0-9]{12}$/.test(trimmed)) {
    return { valid: false, reason: 'Invalid Uganda NIN format. Expected CM/CF + 12 characters' };
  }
  return { valid: true, normalized: trimmed };
}

function decodeBase64ToArrayBuffer(b64) {
  const clean = b64.includes(',') ? b64.split(',')[1] : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function saveImageToR2(env, path, base64Data, contentType) {
  const buffer = decodeBase64ToArrayBuffer(base64Data);
  await env.MEDIA_BUCKET.put(path, buffer, {
    httpMetadata: { contentType: contentType || 'image/jpeg' },
  });
  return 'https://device-finance-api.whiteghostpheonix.workers.dev/media/' + path;
}

async function logAudit(env, entity, entity_id, action, details) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (entity, entity_id, action, details) VALUES (?, ?, ?, ?)`
    ).bind(entity, String(entity_id), action,
      typeof details === 'string' ? details : JSON.stringify(details)).run();
  } catch (_) {}
}

async function queueCommand(env, imei, command, reason) {
  const last = await env.DB.prepare(
    `SELECT id, command, status FROM commands WHERE device_imei = ? ORDER BY id DESC LIMIT 1`
  ).bind(imei).first();
  const existing = (last && last.command === command
    && (last.status === 'queued' || last.status === 'sent')) ? last : null;
  if (existing) return { id: existing.id, deduplicated: true };

  const payload = JSON.stringify({ action: command, reason, ts: Date.now() });
  const result = await env.DB.prepare(
    `INSERT INTO commands (device_imei, command, reason, status, payload) VALUES (?, ?, ?, 'queued', ?)`
  ).bind(imei, command, reason, payload).run();
  await logAudit(env, 'command', result.meta.last_row_id, 'queued', { imei, command, reason });
  try { await dispatchPendingCommands(env, 5); } catch (_) {}
  return { id: result.meta.last_row_id, deduplicated: false };
}

async function dispatchPendingCommands(env, limit = 50) {
  const rows = await env.DB.prepare(
    `SELECT c.*, d.fcm_token FROM commands c
     JOIN devices d ON c.device_imei = d.imei
     WHERE c.status = 'queued' ORDER BY c.created_at ASC LIMIT ?`
  ).bind(limit).all();
  const results = { attempted: 0, sent: 0, failed: 0, skipped_no_token: 0 };
  for (const cmd of rows.results) {
    results.attempted++;
    if (!cmd.fcm_token) {
      results.skipped_no_token++;
      await env.DB.prepare(`UPDATE commands SET attempts = attempts + 1, error_message = 'no_fcm_token' WHERE id = ?`).bind(cmd.id).run();
      continue;
    }
    try {
      const payload = JSON.parse(cmd.payload || '{}');
      await sendFcm(env, cmd.fcm_token, payload);
      await env.DB.prepare(
        `UPDATE commands SET status = 'sent', sent_at = CURRENT_TIMESTAMP, attempts = attempts + 1, error_message = NULL WHERE id = ?`
      ).bind(cmd.id).run();
      await logAudit(env, 'command', cmd.id, 'sent', { imei: cmd.device_imei });
      results.sent++;
    } catch (err) {
      await env.DB.prepare(
        `UPDATE commands SET attempts = attempts + 1, error_message = ? WHERE id = ?`
      ).bind(String(err.message || err).slice(0, 500), cmd.id).run();
      await logAudit(env, 'command', cmd.id, 'send_failed', { error: String(err.message || err) });
      results.failed++;
    }
  }
  return results;
}

async function detectOverdue(env) {
  const overdue = await env.DB.prepare(`
    SELECT s.id, s.device_imei FROM schedules s
    WHERE s.status = 'pending'
      AND date(s.due_date, '+' || COALESCE((SELECT grace_period_days FROM payment_plans p WHERE p.id = s.plan_id), 3) || ' days') < date('now')
  `).all();
  const results = { marked_overdue: 0, devices_locked: 0, commands_queued: 0, commands_deduplicated: 0 };
  const touched = new Set();
  for (const row of overdue.results) {
    await env.DB.prepare(`UPDATE schedules SET status = 'overdue' WHERE id = ?`).bind(row.id).run();
    results.marked_overdue++;
    touched.add(row.device_imei);
  }
  for (const imei of touched) {
    const device = await env.DB.prepare(`SELECT status FROM devices WHERE imei = ?`).bind(imei).first();
    if (device && device.status !== 'locked') {
      await env.DB.prepare(`UPDATE devices SET status = 'locked' WHERE imei = ?`).bind(imei).run();
      results.devices_locked++;
    }
    const cmd = await queueCommand(env, imei, 'LOCK', 'overdue');
    if (cmd.deduplicated) results.commands_deduplicated++; else results.commands_queued++;
  }
  return results;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    try {
      if (path === '/health') return json({ status: 'ok', market: 'Uganda', time: new Date().toISOString() });

      if (path.startsWith('/media/') && (request.method === 'GET' || request.method === 'HEAD')) {
        if (!env.MEDIA_BUCKET) return new Response('Media bucket not bound', { status: 500 });
        const key = path.slice('/media/'.length);
        const obj = await env.MEDIA_BUCKET.get(key);
        if (!obj) return new Response('Not found', { status: 404 });
        const headers = new Headers();
        headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
        headers.set('Cache-Control', 'public, max-age=86400');
        return new Response(obj.body, { status: 200, headers });
      }

      if (path === '/download/apk' || path.startsWith('/download/apk/')) {
        if (!env.APK_BUCKET) return new Response('APK bucket not bound', { status: 500 });
        const filename = path.split('/').pop() || 'signal-dpc-v0.2.1-alpha.apk';
        const key = (filename === 'download' || filename === 'apk') ? 'signal-dpc-v0.2.1-alpha.apk' : filename;
        const obj = await env.APK_BUCKET.get(key);
        if (!obj) return new Response('APK not found: ' + key, { status: 404 });
        const headers = new Headers();
        headers.set('Content-Type', 'application/vnd.android.package-archive');
        headers.set('Content-Length', obj.size.toString());
        headers.set('Cache-Control', 'public, max-age=3600');
        headers.set('Content-Disposition', 'attachment; filename="' + key + '"');
        return new Response(obj.body, { status: 200, headers });
      }

      if (path === '/pay' && (request.method === 'GET' || request.method === 'HEAD')) {
        const imei = url.searchParams.get('imei') || '';
        const amount = url.searchParams.get('amount') || '0';
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Signal Electronics — Payment</title>
<style>* { box-sizing: border-box; } body { font-family: -apple-system, sans-serif; background: #0F62FE; color: #fff; margin: 0; padding: 24px; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.card { background: #fff; color: #1a1a1a; border-radius: 16px; padding: 32px 24px; max-width: 400px; width: 100%; }
h1 { margin: 0 0 8px; font-size: 22px; color: #0F62FE; } .amount { font-size: 40px; font-weight: bold; margin: 24px 0; color: #0F62FE; text-align: center; }
.btn { display: block; width: 100%; padding: 16px; margin: 12px 0; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; text-decoration: none; text-align: center; }
.btn-mtn { background: #FFCC00; color: #000; } .btn-airtel { background: #ED1C24; color: #fff; } .btn-alt { background: #f0f0f0; color: #333; }</style>
</head><body><div class="card"><h1>Pay Installment</h1><div style="color:#666;font-size:14px;">Signal Electronics</div>
<div style="font-size:12px;color:#999;margin-top:16px;">Device: ${imei}</div>
<div class="amount">UGX ${Number(amount).toLocaleString()}</div>
<a class="btn btn-mtn" href="tel:*165%23">📱 Pay with MTN MoMo (*165#)</a>
<a class="btn btn-airtel" href="tel:*185%23">📱 Pay with Airtel Money (*185#)</a>
<a class="btn btn-alt" href="tel:+256706352822">💬 Call Support</a></div></body></html>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      if (path === '/payment-success' || path === '/pay/payment-success') {
        return new Response('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment Successful</title><style>body{font-family:sans-serif;background:#0F62FE;color:#fff;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}.box{background:#fff;color:#1a1a1a;padding:40px 24px;border-radius:16px;text-align:center;max-width:400px;}.check{font-size:72px;margin-bottom:16px;}h1{color:#0F62FE;font-size:24px;margin:0 0 8px;}</style></head><body><div class="box"><div class="check">✅</div><h1>Payment Received</h1><p>Your device will unlock momentarily.</p><p style="font-size:12px;margin-top:24px;">Signal Electronics • +256 706 352 822</p></div></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      if (path === '/api/apk/latest' && request.method === 'GET') {
        return json({ version: '0.2.1', apk_url: 'https://device-finance-api.whiteghostpheonix.workers.dev/download/apk/signal-dpc-v0.2.1-alpha.apk', released: '2026-10-02' });
      }

      if (path === '/api/devices' && request.method === 'POST') {
        const { imei, customer_name, customer_phone, fcm_token, pending_plan_id, start_date } = await request.json();
        const reseller = getResellerEmail(request);
        const existing = await env.DB.prepare(`SELECT imei FROM devices WHERE imei = ?`).bind(imei).first();
        if (existing) {
          await env.DB.prepare(`UPDATE devices SET customer_name = COALESCE(?, customer_name), customer_phone = COALESCE(?, customer_phone), fcm_token = COALESCE(?, fcm_token), reseller_email = COALESCE(?, reseller_email) WHERE imei = ?`)
            .bind(customer_name || null, customer_phone || null, fcm_token || null, reseller || null, imei).run();
        } else {
          await env.DB.prepare(`INSERT INTO devices (imei, customer_name, customer_phone, fcm_token, reseller_email) VALUES (?, ?, ?, ?, ?)`)
            .bind(imei, customer_name || 'Unknown', customer_phone || '', fcm_token || null, reseller || null).run();
        }
        let planAssigned = false;
        if (pending_plan_id) {
          const existingSchedule = await env.DB.prepare(`SELECT COUNT(*) as c FROM schedules WHERE device_imei = ?`).bind(imei).first();
          if (existingSchedule.c === 0) {
            const plan = await env.DB.prepare(`SELECT * FROM payment_plans WHERE id = ?`).bind(pending_plan_id).first();
            if (plan) {
              const installments = await env.DB.prepare(`SELECT * FROM plan_installments WHERE plan_id = ? ORDER BY installment_number`).bind(pending_plan_id).all();
              if (installments.results?.length) {
                const start = new Date(start_date || Date.now());
                const stmts = installments.results.map(inst => {
                  const dueDate = new Date(start);
                  dueDate.setDate(dueDate.getDate() + Number(inst.offset_days || 0));
                  return env.DB.prepare(`INSERT INTO schedules (device_imei, plan_id, installment_number, due_date, amount_due_ugx) VALUES (?, ?, ?, ?, ?)`)
                    .bind(imei, pending_plan_id, inst.installment_number, dueDate.toISOString().split('T')[0], Number(inst.amount_ugx));
                });
                for (let i = 0; i < stmts.length; i += 20) await env.DB.batch(stmts.slice(i, i + 20));
                planAssigned = true;
                await logAudit(env, 'device', imei, 'plan_auto_assigned', { plan_id: pending_plan_id, installments: installments.results.length });
              }
            }
          }
        }
        await logAudit(env, 'device', imei, 'registered', { customer_name, reseller, planAssigned });
        return json({ success: true, imei, plan_assigned: planAssigned });
      }

      if (path.match(/^\/api\/devices\/[^/]+\/fcm$/) && request.method === 'PUT') {
        const imei = path.split('/')[3];
        const { fcm_token } = await request.json().catch(() => ({}));
        if (!fcm_token) return json({ error: 'fcm_token required' }, 400);
        await env.DB.prepare(`UPDATE devices SET fcm_token = ? WHERE imei = ?`).bind(fcm_token, imei).run();
        return json({ success: true });
      }

      if (path.match(/^\/api\/devices\/[^/]+\/heartbeat$/) && request.method === 'POST') {
        const imei = path.split('/')[3];
        const body = await request.json().catch(() => ({}));
        const device = await env.DB.prepare(`SELECT imei, status FROM devices WHERE imei = ?`).bind(imei).first();
        if (!device) return json({ error: 'Device not registered' }, 404);
        await logAudit(env, 'device', imei, 'heartbeat', body);
        const schedules = await env.DB.prepare(
          `SELECT s.installment_number, s.due_date, s.amount_due_ugx, s.amount_paid_ugx, s.status, (SELECT grace_period_days FROM payment_plans p WHERE p.id = s.plan_id) as grace_days FROM schedules s WHERE s.device_imei = ? ORDER BY s.installment_number`
        ).bind(imei).all();
        return json({ success: true, ts: Date.now(), device_status: device.status, schedule: schedules.results || [] });
      }

      if (path === '/api/device/ack' && request.method === 'POST') {
        const { command_id } = await request.json().catch(() => ({}));
        if (!command_id) return json({ error: 'command_id required' }, 400);
        await env.DB.prepare(`UPDATE commands SET status = 'acknowledged', acknowledged_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(command_id).run();
        await logAudit(env, 'command', command_id, 'acknowledged', { via: 'device' });
        return json({ success: true, command_id });
      }

      if (path === '/api/device-status' && (request.method === 'GET' || request.method === 'HEAD')) {
        const imei = url.searchParams.get('imei');
        if (!imei) return json({ error: 'imei required' }, 400);
        const device = await env.DB.prepare(`SELECT imei, status FROM devices WHERE imei = ?`).bind(imei).first();
        if (!device) return json({ error: 'Not found' }, 404);
        const overdueCount = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM schedules WHERE device_imei = ? AND status = 'overdue'`).bind(imei).first();
        const nextDue = await env.DB.prepare(`SELECT id, due_date, amount_due_ugx, amount_paid_ugx FROM schedules WHERE device_imei = ? AND status IN ('pending','overdue') ORDER BY due_date ASC LIMIT 1`).bind(imei).first();
        return json({ imei: device.imei, status: device.status, overdue_count: overdueCount.cnt, next_due: nextDue || null });
      }

      if (path === '/api/payments/auto' && request.method === 'POST') {
        const { imei, schedule_id, amount_ugx, method, reference } = await request.json();
        if (!imei || !amount_ugx) return json({ error: 'imei and amount_ugx required' }, 400);
        let schedule;
        if (schedule_id) schedule = await env.DB.prepare(`SELECT * FROM schedules WHERE id = ?`).bind(schedule_id).first();
        else schedule = await env.DB.prepare(`SELECT * FROM schedules WHERE device_imei = ? AND status IN ('pending','overdue') ORDER BY installment_number ASC LIMIT 1`).bind(imei).first();
        if (!schedule) return json({ error: 'No unpaid schedule found' }, 404);
        const newPaid = (schedule.amount_paid_ugx || 0) + Number(amount_ugx);
        const newStatus = newPaid >= schedule.amount_due_ugx ? 'paid' : schedule.status;
        await env.DB.prepare(`UPDATE schedules SET amount_paid_ugx = ?, status = ? WHERE id = ?`).bind(newPaid, newStatus, schedule.id).run();
        await env.DB.prepare(`INSERT INTO transactions (schedule_id, amount_ugx, payment_method, reference) VALUES (?, ?, ?, ?)`).bind(schedule.id, amount_ugx, method || 'unknown', reference || null).run();
        await logAudit(env, 'schedule', schedule.id, 'payment_auto', { amount_ugx, method, reference, imei });
        const overdueLeft = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM schedules WHERE device_imei = ? AND status = 'overdue'`).bind(imei).first();
        let unlocked = false;
        if (overdueLeft.cnt === 0) {
          await env.DB.prepare(`UPDATE devices SET status = 'active' WHERE imei = ?`).bind(imei).run();
          await queueCommand(env, imei, 'UNLOCK', 'payment_auto_cleared');
          unlocked = true;
        }
        return json({ success: true, schedule_id: schedule.id, schedule_status: newStatus, device_unlocked: unlocked, overdue_remaining: overdueLeft.cnt });
      }

      if (path === '/api/payments/initiate' && request.method === 'POST') {
        const { imei, amount_ugx, method } = await request.json();
        if (!imei || !amount_ugx) return json({ error: 'imei and amount_ugx required' }, 400);
        const intentId = 'PI-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        await logAudit(env, 'payment_intent', intentId, 'created', { imei, amount_ugx, method });
        return json({ success: true, intent_id: intentId, amount_ugx, instructions: method === 'mtn' ? 'Dial *165#' : method === 'airtel' ? 'Dial *185#' : 'Follow the prompt' });
      }

      if (path === '/api/dashboard/summary' && request.method === 'GET') {
        const reseller = getResellerEmail(request);
        if (reseller) {
          const q = (sql) => env.DB.prepare(sql).bind(reseller).first();
          const [td, ad, ld, od, tc, pc] = await Promise.all([
            q(`SELECT COUNT(*) as c FROM devices WHERE reseller_email = ?`),
            q(`SELECT COUNT(*) as c FROM devices WHERE status='active' AND reseller_email = ?`),
            q(`SELECT COUNT(*) as c FROM devices WHERE status='locked' AND reseller_email = ?`),
            q(`SELECT COUNT(*) as c FROM schedules WHERE status='overdue' AND device_imei IN (SELECT imei FROM devices WHERE reseller_email = ?)`),
            q(`SELECT COALESCE(SUM(t.amount_ugx),0) as s FROM transactions t JOIN schedules s ON t.schedule_id = s.id WHERE s.device_imei IN (SELECT imei FROM devices WHERE reseller_email = ?)`),
            q(`SELECT COUNT(*) as c FROM commands WHERE status='queued' AND device_imei IN (SELECT imei FROM devices WHERE reseller_email = ?)`),
          ]);
          return json({ total_devices: td.c, active_devices: ad.c, locked_devices: ld.c, overdue_schedules: od.c, total_collected_ugx: tc.s, pending_commands: pc.c });
        }
        const [td, ad, ld, od, tc, pc] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) as c FROM devices`).first(),
          env.DB.prepare(`SELECT COUNT(*) as c FROM devices WHERE status='active'`).first(),
          env.DB.prepare(`SELECT COUNT(*) as c FROM devices WHERE status='locked'`).first(),
          env.DB.prepare(`SELECT COUNT(*) as c FROM schedules WHERE status='overdue'`).first(),
          env.DB.prepare(`SELECT COALESCE(SUM(amount_ugx),0) as s FROM transactions`).first(),
          env.DB.prepare(`SELECT COUNT(*) as c FROM commands WHERE status='queued'`).first(),
        ]);
        return json({ total_devices: td.c, active_devices: ad.c, locked_devices: ld.c, overdue_schedules: od.c, total_collected_ugx: tc.s, pending_commands: pc.c });
      }

      if (path === '/api/dashboard/devices' && request.method === 'GET') {
        const reseller = getResellerEmail(request);
        const base = `SELECT d.imei, d.customer_name, d.customer_phone, d.status, d.created_at, d.reseller_email, (SELECT COUNT(*) FROM schedules s WHERE s.device_imei = d.imei AND s.status = 'paid') as paid_count, (SELECT COUNT(*) FROM schedules s WHERE s.device_imei = d.imei) as total_count, (SELECT SUM(s.amount_due_ugx - COALESCE(s.amount_paid_ugx,0)) FROM schedules s WHERE s.device_imei = d.imei AND s.status != 'paid') as balance_ugx, (SELECT s.due_date FROM schedules s WHERE s.device_imei = d.imei AND s.status IN ('pending','overdue') ORDER BY s.due_date ASC LIMIT 1) as next_due_date FROM devices d`;
        const rows = reseller
          ? await env.DB.prepare(base + ` WHERE d.reseller_email = ? ORDER BY d.created_at DESC LIMIT 500`).bind(reseller).all()
          : await env.DB.prepare(base + ` ORDER BY d.created_at DESC LIMIT 500`).all();
        return json(rows.results);
      }

      if (path.match(/^\/api\/dashboard\/devices\/[^/]+$/) && request.method === 'GET') {
        const imei = path.split('/').pop();
        const device = await env.DB.prepare(`SELECT * FROM devices WHERE imei = ?`).bind(imei).first();
        if (!device) return json({ error: 'Not found' }, 404);
        const schedules = await env.DB.prepare(`SELECT * FROM schedules WHERE device_imei = ? ORDER BY installment_number`).bind(imei).all();
        const transactions = await env.DB.prepare(`SELECT t.* FROM transactions t JOIN schedules s ON t.schedule_id = s.id WHERE s.device_imei = ? ORDER BY t.paid_at DESC LIMIT 50`).bind(imei).all();
        const commands = await env.DB.prepare(`SELECT * FROM commands WHERE device_imei = ? ORDER BY created_at DESC LIMIT 20`).bind(imei).all();
        const customer = await env.DB.prepare(`SELECT * FROM customers WHERE imei = ?`).bind(imei).first();
        const guarantors = await env.DB.prepare(`SELECT * FROM guarantors WHERE customer_imei = ? ORDER BY slot`).bind(imei).all();
        return json({ device, schedules: schedules.results, transactions: transactions.results, commands: commands.results, customer: customer || null, guarantors: guarantors.results || [] });
      }

      if (path === '/api/admin/run-overdue-check' && request.method === 'POST') {
        const result = await detectOverdue(env);
        return json({ success: true, ...result });
      }

      if (path === '/api/commands/lock' && request.method === 'POST') {
        const { imei, reason } = await request.json();
        if (!imei) return json({ error: 'imei required' }, 400);
        await env.DB.prepare(`UPDATE devices SET status = 'locked' WHERE imei = ?`).bind(imei).run();
        const cmd = await queueCommand(env, imei, 'LOCK', reason || 'manual');
        return json({ success: true, command_id: cmd.id, deduplicated: cmd.deduplicated });
      }
      if (path === '/api/commands/unlock' && request.method === 'POST') {
        const { imei, reason } = await request.json();
        if (!imei) return json({ error: 'imei required' }, 400);
        await env.DB.prepare(`UPDATE devices SET status = 'active' WHERE imei = ?`).bind(imei).run();
        const cmd = await queueCommand(env, imei, 'UNLOCK', reason || 'manual');
        return json({ success: true, command_id: cmd.id, deduplicated: cmd.deduplicated });
      }

      if (path === '/api/commands' && request.method === 'GET') {
        const status = url.searchParams.get('status');
        const q = status
          ? env.DB.prepare(`SELECT * FROM commands WHERE status = ? ORDER BY created_at DESC LIMIT 100`).bind(status)
          : env.DB.prepare(`SELECT * FROM commands ORDER BY created_at DESC LIMIT 100`);
        return json((await q.all()).results);
      }

      if (path === '/api/admin/test-push' && request.method === 'POST') {
        const { fcm_token, action, reason } = await request.json();
        if (!fcm_token) return json({ error: 'fcm_token required' }, 400);
        try {
          const resp = await sendFcm(env, fcm_token, { action: action || 'TEST', reason: reason || 'manual_test', ts: Date.now() });
          return json({ success: true, fcm_response: resp });
        } catch (err) { return json({ success: false, error: String(err.message || err) }, 500); }
      }

      if (path === '/api/admin/dispatch-queue' && request.method === 'POST') {
        const result = await dispatchPendingCommands(env, 100);
        return json({ success: true, ...result });
      }

      if (path === '/api/payments' && request.method === 'POST') {
        const { schedule_id, amount_ugx, payment_method, reference } = await request.json();
        if (!schedule_id || !amount_ugx) return json({ error: 'schedule_id and amount_ugx required' }, 400);
        const schedule = await env.DB.prepare(`SELECT * FROM schedules WHERE id = ?`).bind(schedule_id).first();
        if (!schedule) return json({ error: 'Schedule not found' }, 404);
        const newPaid = (schedule.amount_paid_ugx || 0) + Number(amount_ugx);
        const newStatus = newPaid >= schedule.amount_due_ugx ? 'paid' : schedule.status;
        await env.DB.prepare(`UPDATE schedules SET amount_paid_ugx = ?, status = ? WHERE id = ?`).bind(newPaid, newStatus, schedule_id).run();
        await env.DB.prepare(`INSERT INTO transactions (schedule_id, amount_ugx, payment_method, reference) VALUES (?, ?, ?, ?)`).bind(schedule_id, amount_ugx, payment_method || 'unknown', reference || null).run();
        await logAudit(env, 'schedule', schedule_id, 'payment_recorded', { amount_ugx, payment_method, reference });
        const overdueLeft = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM schedules WHERE device_imei = ? AND status = 'overdue'`).bind(schedule.device_imei).first();
        let unlocked = false;
        if (overdueLeft.cnt === 0) {
          await env.DB.prepare(`UPDATE devices SET status = 'active' WHERE imei = ?`).bind(schedule.device_imei).run();
          await queueCommand(env, schedule.device_imei, 'UNLOCK', 'overdue_cleared');
          unlocked = true;
        }
        return json({ success: true, schedule_status: newStatus, device_unlocked: unlocked, overdue_remaining: overdueLeft.cnt });
      }

      if (path === '/api/audit' && request.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 100);
        const rows = await env.DB.prepare(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
        return json(rows.results);
      }

      // ═══════════════════════════════════════════
      // PLANS — amount × period model
      // ═══════════════════════════════════════════
      if (path === '/api/plans' && request.method === 'POST') {
        const body = await request.json();
        const { plan_name, grace_period_days, frequency, amount_per_period, period_count, has_deposit, deposit_amount, deposit_due_days, notes } = body;
        if (!plan_name) return json({ error: 'plan_name required' }, 400);
        if (!amount_per_period || !period_count || !frequency) return json({ error: 'amount_per_period, period_count, and frequency required' }, 400);
        const count = Number(period_count);
        if (count < 1 || count > 2000) return json({ error: 'period_count must be 1-2000' }, 400);
        const amount = Number(amount_per_period);
        const deposit = has_deposit ? Number(deposit_amount || 0) : 0;
        const total = amount * count + deposit;
        const stepDays = frequency === 'daily' ? 1 : frequency === 'weekly' ? 7 : 30;
        const result = await env.DB.prepare(
          `INSERT INTO payment_plans (plan_name, total_amount_ugx, installment_count, grace_period_days, frequency, notes, amount_per_period, period_type, period_count, has_deposit, deposit_amount, deposit_due_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(plan_name, total, count, grace_period_days || 3, frequency, notes || null, amount, frequency, count, has_deposit ? 1 : 0, deposit, has_deposit ? (deposit_due_days || 0) : 0).run();
        const planId = result.meta.last_row_id;
        const allInstallments = [];
        if (has_deposit && deposit > 0) allInstallments.push({ offset_days: Number(deposit_due_days || 0), amount_ugx: deposit, label: 'Deposit' });
        for (let i = 0; i < count; i++) {
          const offset = (has_deposit ? Number(deposit_due_days || 0) : 0) + (i + 1) * stepDays;
          allInstallments.push({ offset_days: offset, amount_ugx: amount, label: `${frequency}_${i + 1}` });
        }
        for (let i = 0; i < allInstallments.length; i += 20) {
          const chunk = allInstallments.slice(i, i + 20);
          const stmts = chunk.map((inst, idx) => env.DB.prepare(
            `INSERT INTO plan_installments (plan_id, installment_number, offset_days, amount_ugx, label) VALUES (?, ?, ?, ?, ?)`
          ).bind(planId, i + idx + 1, inst.offset_days, inst.amount_ugx, inst.label));
          await env.DB.batch(stmts);
        }
        await logAudit(env, 'plan', planId, 'created', { plan_name, frequency, period_count: count, amount, total });
        return json({ success: true, plan_id: planId, total, period_count: count, amount_per_period: amount, deposit });
      }

      if (path === '/api/plans' && request.method === 'GET') {
        const rows = await env.DB.prepare(`SELECT * FROM payment_plans ORDER BY created_at DESC`).all();
        return json(rows.results);
      }

      if (path.match(/^\/api\/plans\/\d+$/) && request.method === 'GET') {
        const id = Number(path.split('/').pop());
        const plan = await env.DB.prepare(`SELECT * FROM payment_plans WHERE id = ?`).bind(id).first();
        if (!plan) return json({ error: 'Not found' }, 404);
        const installments = await env.DB.prepare(`SELECT * FROM plan_installments WHERE plan_id = ? ORDER BY installment_number`).bind(id).all();
        return json({ ...plan, installments: installments.results || [] });
      }

      if (path.match(/^\/api\/plans\/\d+$/) && request.method === 'PUT') {
        const id = Number(path.split('/').pop());
        const body = await request.json();
        const plan = await env.DB.prepare(`SELECT * FROM payment_plans WHERE id = ?`).bind(id).first();
        if (!plan) return json({ error: 'Not found' }, 404);
        await env.DB.prepare(`UPDATE payment_plans SET plan_name=?, grace_period_days=?, notes=? WHERE id=?`)
          .bind(body.plan_name || plan.plan_name, body.grace_period_days ?? plan.grace_period_days, body.notes ?? plan.notes, id).run();
        return json({ success: true, plan_id: id });
      }

      if (path === '/api/assign-plan' && request.method === 'POST') {
        const { imei, plan_id, start_date } = await request.json();
        const plan = await env.DB.prepare(`SELECT * FROM payment_plans WHERE id = ?`).bind(plan_id).first();
        if (!plan) return json({ error: 'Plan not found' }, 404);
        const installments = await env.DB.prepare(`SELECT * FROM plan_installments WHERE plan_id = ? ORDER BY installment_number`).bind(plan_id).all();
        if (!installments.results?.length) return json({ error: 'Plan has no installments' }, 400);
        const start = new Date(start_date || Date.now());
        const stmts = installments.results.map(inst => {
          const dueDate = new Date(start);
          dueDate.setDate(dueDate.getDate() + Number(inst.offset_days || 0));
          return env.DB.prepare(`INSERT INTO schedules (device_imei, plan_id, installment_number, due_date, amount_due_ugx) VALUES (?, ?, ?, ?, ?)`)
            .bind(imei, plan_id, inst.installment_number, dueDate.toISOString().split('T')[0], Number(inst.amount_ugx));
        });
        for (let i = 0; i < stmts.length; i += 20) await env.DB.batch(stmts.slice(i, i + 20));
        await logAudit(env, 'device', imei, 'plan_assigned', { plan_id, installments: installments.results.length });
        return json({ success: true, installments_created: installments.results.length, total: plan.total_amount_ugx });
      }

      // ═══════════════════════════════════════════
      // CUSTOMERS (KYC + NIN uniqueness)
      // ═══════════════════════════════════════════
      if (path === '/api/customers' && request.method === 'POST') {
        const body = await request.json();
        const { imei, full_name, phone, nin, dob, address, occupation, monthly_income, photo_base64, photo_with_reseller_base64, device_photo_base64, id_front_base64, id_back_base64 } = body;
        if (!imei || !full_name) return json({ error: 'imei and full_name required' }, 400);
        const ninCheck = validateUgandaNIN(nin);
        if (!ninCheck.valid) return json({ error: ninCheck.reason, kyc_status: 'rejected' }, 400);
        const dup = await env.DB.prepare(`SELECT imei FROM customers WHERE nin = ? AND imei != ?`).bind(ninCheck.normalized, imei).first();
        if (dup) return json({ error: 'This NIN is already registered to another device', kyc_status: 'rejected' }, 400);
        const dupR = await env.DB.prepare(`SELECT email FROM resellers WHERE nin = ?`).bind(ninCheck.normalized).first();
        if (dupR) return json({ error: 'This NIN belongs to a reseller', kyc_status: 'rejected' }, 400);
        const dupG = await env.DB.prepare(`SELECT customer_imei FROM guarantors WHERE nin = ?`).bind(ninCheck.normalized).first();
        if (dupG) return json({ error: 'This NIN is registered as a guarantor', kyc_status: 'rejected' }, 400);

        const photoUrl = photo_base64 ? await saveImageToR2(env, `customers/${imei}/photo.jpg`, photo_base64, 'image/jpeg') : null;
        const withResellerUrl = photo_with_reseller_base64 ? await saveImageToR2(env, `customers/${imei}/with-reseller.jpg`, photo_with_reseller_base64, 'image/jpeg') : null;
        const devicePhotoUrl = device_photo_base64 ? await saveImageToR2(env, `customers/${imei}/device.jpg`, device_photo_base64, 'image/jpeg') : null;
        const idFrontUrl = id_front_base64 ? await saveImageToR2(env, `customers/${imei}/id-front.jpg`, id_front_base64, 'image/jpeg') : null;
        const idBackUrl = id_back_base64 ? await saveImageToR2(env, `customers/${imei}/id-back.jpg`, id_back_base64, 'image/jpeg') : null;

        const existing = await env.DB.prepare(`SELECT id FROM customers WHERE imei = ?`).bind(imei).first();
        if (existing) {
          await env.DB.prepare(`UPDATE customers SET full_name=?, phone=?, nin=?, dob=?, address=?, occupation=?, monthly_income=?, photo_url=COALESCE(?, photo_url), photo_with_reseller_url=COALESCE(?, photo_with_reseller_url), device_photo_url=COALESCE(?, device_photo_url), id_front_url=COALESCE(?, id_front_url), id_back_url=COALESCE(?, id_back_url), nin_verified=1, kyc_status='verified', updated_at=CURRENT_TIMESTAMP WHERE imei=?`)
            .bind(full_name, phone || null, ninCheck.normalized, dob || null, address || null, occupation || null, monthly_income || null, photoUrl, withResellerUrl, devicePhotoUrl, idFrontUrl, idBackUrl, imei).run();
        } else {
          await env.DB.prepare(`INSERT INTO customers (imei, full_name, phone, nin, dob, address, occupation, monthly_income, photo_url, photo_with_reseller_url, device_photo_url, id_front_url, id_back_url, nin_verified, kyc_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'verified')`)
            .bind(imei, full_name, phone || null, ninCheck.normalized, dob || null, address || null, occupation || null, monthly_income || null, photoUrl, withResellerUrl, devicePhotoUrl, idFrontUrl, idBackUrl).run();
        }
        await logAudit(env, 'customer', imei, 'kyc_saved', { full_name, nin: ninCheck.normalized });
        return json({ success: true, imei, nin_verified: true, kyc_status: 'verified' });
      }

      if (path.match(/^\/api\/customers\/[^/]+$/) && request.method === 'GET') {
        const imei = path.split('/')[3];
        const customer = await env.DB.prepare(`SELECT * FROM customers WHERE imei = ?`).bind(imei).first();
        const guarantors = await env.DB.prepare(`SELECT * FROM guarantors WHERE customer_imei = ? ORDER BY slot`).bind(imei).all();
        return json({ customer: customer || null, guarantors: guarantors.results || [] });
      }

      if (path.match(/^\/api\/customers\/[^/]+\/guarantors$/) && request.method === 'POST') {
        const imei = path.split('/')[3];
        const body = await request.json();
        const { slot, full_name, phone, nin, relationship, address, occupation, photo_base64, id_front_base64 } = body;
        if (!slot || slot < 1 || slot > 2) return json({ error: 'slot must be 1 or 2' }, 400);
        let ninNorm = null;
        if (nin && nin.trim()) {
          const c = validateUgandaNIN(nin);
          if (!c.valid) return json({ error: `Guarantor ${slot}: ${c.reason}` }, 400);
          ninNorm = c.normalized;
          const dC = await env.DB.prepare(`SELECT imei FROM customers WHERE nin = ?`).bind(ninNorm).first();
          if (dC && dC.imei !== imei) return json({ error: `Guarantor ${slot}: NIN already used` }, 400);
          const dR = await env.DB.prepare(`SELECT email FROM resellers WHERE nin = ?`).bind(ninNorm).first();
          if (dR) return json({ error: `Guarantor ${slot}: NIN belongs to reseller` }, 400);
          const dG = await env.DB.prepare(`SELECT customer_imei FROM guarantors WHERE nin = ? AND NOT (customer_imei = ? AND slot = ?)`).bind(ninNorm, imei, slot).first();
          if (dG) return json({ error: `Guarantor ${slot}: NIN already registered` }, 400);
        }
        const photoUrl = photo_base64 ? await saveImageToR2(env, `customers/${imei}/guarantor-${slot}.jpg`, photo_base64, 'image/jpeg') : null;
        const idFrontUrl = id_front_base64 ? await saveImageToR2(env, `customers/${imei}/guarantor-${slot}-id.jpg`, id_front_base64, 'image/jpeg') : null;
        const existing = await env.DB.prepare(`SELECT id FROM guarantors WHERE customer_imei = ? AND slot = ?`).bind(imei, slot).first();
        if (existing) {
          await env.DB.prepare(`UPDATE guarantors SET full_name=?, phone=?, nin=?, relationship=?, address=?, occupation=?, photo_url=COALESCE(?, photo_url), id_front_url=COALESCE(?, id_front_url), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .bind(full_name || null, phone || null, ninNorm, relationship || null, address || null, occupation || null, photoUrl, idFrontUrl, existing.id).run();
        } else {
          await env.DB.prepare(`INSERT INTO guarantors (customer_imei, slot, full_name, phone, nin, relationship, address, occupation, photo_url, id_front_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(imei, slot, full_name || null, phone || null, ninNorm, relationship || null, address || null, occupation || null, photoUrl, idFrontUrl).run();
        }
        await logAudit(env, 'guarantor', imei, 'saved', { slot, full_name, nin: ninNorm });
        return json({ success: true, imei, slot });
      }

      // ═══════════════════════════════════════════
      // RESELLERS
      // ═══════════════════════════════════════════
      if (path === '/api/resellers' && request.method === 'POST') {
        const body = await request.json();
        const { email, name, phone, region, address, nin, occupation, photo_base64, id_front_base64, id_back_base64 } = body;
        if (!email) return json({ error: 'email required' }, 400);
        let ninNorm = null;
        if (nin && nin.trim()) {
          const c = validateUgandaNIN(nin);
          if (!c.valid) return json({ error: c.reason }, 400);
          ninNorm = c.normalized;
          const d = await env.DB.prepare(`SELECT email FROM resellers WHERE nin = ? AND email != ?`).bind(ninNorm, email).first();
          if (d) return json({ error: 'NIN already registered to another reseller' }, 400);
          const dC = await env.DB.prepare(`SELECT imei FROM customers WHERE nin = ?`).bind(ninNorm).first();
          if (dC) return json({ error: 'NIN already used as customer' }, 400);
          const dG = await env.DB.prepare(`SELECT customer_imei FROM guarantors WHERE nin = ?`).bind(ninNorm).first();
          if (dG) return json({ error: 'NIN already used as guarantor' }, 400);
        }
        const safeEmail = email.replace(/[^a-z0-9]/gi, '_');
        const photoUrl = photo_base64 ? await saveImageToR2(env, `resellers/${safeEmail}/photo.jpg`, photo_base64, 'image/jpeg') : null;
        const idFrontUrl = id_front_base64 ? await saveImageToR2(env, `resellers/${safeEmail}/id-front.jpg`, id_front_base64, 'image/jpeg') : null;
        const idBackUrl = id_back_base64 ? await saveImageToR2(env, `resellers/${safeEmail}/id-back.jpg`, id_back_base64, 'image/jpeg') : null;
        const existing = await env.DB.prepare(`SELECT email FROM resellers WHERE email = ?`).bind(email).first();
        if (existing) {
          await env.DB.prepare(`UPDATE resellers SET name=?, phone=?, region=?, address=?, nin=?, occupation=?, photo_url=COALESCE(?, photo_url), id_front_url=COALESCE(?, id_front_url), id_back_url=COALESCE(?, id_back_url), nin_verified=1, updated_at=CURRENT_TIMESTAMP WHERE email=?`)
            .bind(name || null, phone || null, region || null, address || null, ninNorm, occupation || null, photoUrl, idFrontUrl, idBackUrl, email).run();
        } else {
          await env.DB.prepare(`INSERT INTO resellers (email, name, phone, region, address, nin, occupation, photo_url, id_front_url, id_back_url, nin_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
            .bind(email, name || null, phone || null, region || null, address || null, ninNorm, occupation || null, photoUrl, idFrontUrl, idBackUrl).run();
        }
        await logAudit(env, 'reseller', email, 'kyc_saved', { name, nin: ninNorm });
        return json({ success: true, email, nin_verified: true });
      }

      if (path === '/api/resellers' && request.method === 'GET') {
        const rows = await env.DB.prepare(`SELECT * FROM resellers ORDER BY created_at DESC`).all();
        return json(rows.results || []);
      }

      if (path.match(/^\/api\/resellers\/[^/]+$/) && request.method === 'GET') {
        const email = decodeURIComponent(path.split('/')[3]);
        const row = await env.DB.prepare(`SELECT * FROM resellers WHERE email = ?`).bind(email).first();
        return json(row || null);
      }

      if (path === '/api/validate-nin' && request.method === 'POST') {
        const { nin } = await request.json();
        const c = validateUgandaNIN(nin);
        if (!c.valid) return json({ valid: false, reason: c.reason });
        const dC = await env.DB.prepare(`SELECT imei FROM customers WHERE nin = ?`).bind(c.normalized).first();
        const dR = await env.DB.prepare(`SELECT email FROM resellers WHERE nin = ?`).bind(c.normalized).first();
        const dG = await env.DB.prepare(`SELECT customer_imei FROM guarantors WHERE nin = ?`).bind(c.normalized).first();
        if (dC || dR || dG) return json({ valid: false, reason: 'NIN already registered' });
        return json({ valid: true, normalized: c.normalized });
      }

      if (path.match(/^\/api\/devices\/[^/]+\/qr$/) && request.method === 'GET') {
        const imei = path.split('/')[3];
        const APK_KEY = 'signal-dpc-v0.2.1-alpha.apk';
        const APK_URL = 'https://device-finance-api.whiteghostpheonix.workers.dev/download/apk/' + APK_KEY;
        const COMPONENT = 'ug.co.signalelectronics.devicefinance/.SignalDeviceAdminReceiver';
        let checksumB64 = '';
        try {
          const apk = await env.APK_BUCKET.get(APK_KEY);
          if (apk) {
            const bytes = await apk.arrayBuffer();
            const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
            checksumB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          }
        } catch (e) { return json({ error: 'R2 read failed' }, 500); }
        if (!checksumB64) return json({ error: 'APK not in R2' }, 404);
        const payload = {
          'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': COMPONENT,
          'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': APK_URL,
          'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM': checksumB64,
          'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
          'android.app.extra.PROVISIONING_SKIP_ENCRYPTION': true,
          'android.app.extra.PROVISIONING_SKIP_USER_SETUP': true,
          'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': { server_url: 'https://device-finance-api.whiteghostpheonix.workers.dev' },
        };
        return json({ imei, payload, payload_json: JSON.stringify(payload) });
      }

      return json({ error: 'Not found', path }, 404);
    } catch (error) {
      const msg = error?.message || error?.toString?.() || 'Unknown server error';
      console.error('Worker error:', msg, error?.stack);
      return json({ error: msg, stack: error?.stack || '' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const result = await detectOverdue(env);
      await logAudit(env, 'system', 'cron', 'overdue_check', result);
      console.log('Cron overdue check:', JSON.stringify(result));
    })());
  },
};
