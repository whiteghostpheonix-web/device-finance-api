import { collectPayment, verifyRohoWebhook } from './rohopay.js';
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

// Generate a short payment code for a device (6 chars: SG + 4 alphanumeric)
function generatePaymentCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SG';
  for (let i = 0; i < 4; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

// Find a device by payment code, IMEI, or phone number
async function findDeviceForPayment(env, { code, phone, amount }) {
  // Try payment code first
  if (code) {
    const byCode = await env.DB.prepare(
      `SELECT imei, customer_phone FROM devices WHERE payment_code = ?`
    ).bind(code.toUpperCase()).first();
    if (byCode) return { device: byCode, method: 'code' };
  }

  // Try phone number (last 9 digits to be flexible)
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    const last9 = digits.slice(-9);
    if (last9.length >= 9) {
      const byPhone = await env.DB.prepare(
        `SELECT imei, customer_phone FROM devices WHERE REPLACE(REPLACE(customer_phone, '+', ''), ' ', '') LIKE ?`
      ).bind('%' + last9).first();
      if (byPhone) return { device: byPhone, method: 'phone' };
    }
  }

  // Try to find by amount + most recent unpaid schedule
  if (amount) {
    // Find a device with an overdue schedule close to this amount
    const byAmount = await env.DB.prepare(
      `SELECT s.device_imei as imei, d.customer_phone FROM schedules s
       JOIN devices d ON s.device_imei = d.imei
       WHERE s.status IN ('pending','overdue')
         AND ABS(s.amount_due_ugx - COALESCE(s.amount_paid_ugx, 0) - ?) < 100
       ORDER BY s.due_date ASC LIMIT 1`
    ).bind(amount).first();
    if (byAmount) return { device: byAmount, method: 'amount' };
  }

  return { device: null, method: null };
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

// ═════════════════════════════════════════════
// Payment processing (shared by webhook + sandbox)
// ═════════════════════════════════════════════
async function processIncomingPayment(env, {
  provider, provider_tx_id, amount_ugx, currency, phone,
  reference, payment_code, fee_amount, raw_payload,
}) {
  // 1. Check idempotency
  if (provider_tx_id) {
    const existing = await env.DB.prepare(
      `SELECT id FROM webhook_events WHERE provider = ? AND event_id = ?`
    ).bind(provider, provider_tx_id).first();
    if (existing) {
      return { success: true, duplicate: true, message: 'Already processed' };
    }
  }

  // 2. Record the webhook event
  const eventResult = await env.DB.prepare(
    `INSERT INTO webhook_events (provider, event_id, event_type, payload) VALUES (?, ?, ?, ?)`
  ).bind(provider, provider_tx_id || 'unknown_' + Date.now(), 'charge.completed', JSON.stringify(raw_payload)).run();
  const webhookEventId = eventResult.meta.last_row_id;

  // 3. Match to a device
  const { device, method } = await findDeviceForPayment(env, {
    code: payment_code || reference,
    phone,
    amount: amount_ugx,
  });

  if (!device) {
    await logAudit(env, 'payment', webhookEventId, 'unmatched', { provider, amount_ugx, phone, reference });
    return { success: false, message: 'No matching device found', webhook_event_id: webhookEventId };
  }

  const imei = device.imei;

  // 4. Get ALL unpaid schedules (to support multi-installment payments)
  const unpaid = await env.DB.prepare(
    `SELECT * FROM schedules WHERE device_imei = ? AND status IN ('pending','overdue')
     ORDER BY installment_number ASC`
  ).bind(imei).all();

  if (!unpaid.results?.length) {
    await logAudit(env, 'payment', webhookEventId, 'no_schedule', { imei, amount_ugx });
    return { success: false, message: 'Device has no unpaid schedule', imei };
  }

  // 5. Apply the payment across schedules (oldest first)
  let remaining = Number(amount_ugx);
  const paidSchedules = [];
  let firstScheduleId = null;

  for (const s of unpaid.results) {
    if (remaining <= 0) break;
    const owed = s.amount_due_ugx - (s.amount_paid_ugx || 0);
    const applied = Math.min(remaining, owed);
    const newPaid = (s.amount_paid_ugx || 0) + applied;
    const newStatus = newPaid >= s.amount_due_ugx ? 'paid' : s.status;

    await env.DB.prepare(
      `UPDATE schedules SET amount_paid_ugx = ?, status = ? WHERE id = ?`
    ).bind(newPaid, newStatus, s.id).run();

    if (newStatus === 'paid') paidSchedules.push(s.id);
    if (!firstScheduleId) firstScheduleId = s.id;

    remaining -= applied;
  }

  // 6. Record a single transaction for the whole payment (attached to first schedule)
  const txResult = await env.DB.prepare(
    `INSERT INTO transactions (schedule_id, amount_ugx, payment_method, reference, provider, provider_tx_id, provider_payload, fee_amount, net_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    firstScheduleId, amount_ugx, provider, reference || provider_tx_id,
    provider, provider_tx_id, JSON.stringify(raw_payload),
    fee_amount || 0, Number(amount_ugx) - (fee_amount || 0)
  ).run();

  // 7. Record the match
  await env.DB.prepare(
    `INSERT INTO payment_matches (webhook_event_id, device_imei, schedule_id, match_method, amount_ugx, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(webhookEventId, imei, firstScheduleId, method, amount_ugx, 'paid').run();

  await logAudit(env, 'payment', txResult.meta.last_row_id, 'recorded', {
    imei, amount_ugx, provider, provider_tx_id, schedule_ids_paid: paidSchedules, method,
    schedules_cleared: paidSchedules.length,
  });

  const newStatus = paidSchedules.length > 0 ? 'paid' : 'pending';

  // 8. Check if overdue is cleared → unlock
  const overdueLeft = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM schedules WHERE device_imei = ? AND status = 'overdue'`
  ).bind(imei).first();

  let unlocked = false;
  if (overdueLeft.cnt === 0) {
    await env.DB.prepare(`UPDATE devices SET status = 'active' WHERE imei = ?`).bind(imei).run();
    await queueCommand(env, imei, 'UNLOCK', 'payment_received');
    unlocked = true;
    await logAudit(env, 'device', imei, 'auto_unlocked', { reason: 'payment_cleared', tx_id: txResult.meta.last_row_id });
  }

  return {
    success: true,
    imei,
    schedule_id: firstScheduleId,
    schedule_status: newStatus,
    device_unlocked: unlocked,
    overdue_remaining: overdueLeft.cnt,
    match_method: method,
    transaction_id: txResult.meta.last_row_id,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    try {
      // ── Health ────────────────────────────────
      if (path === '/health') return json({ status: 'ok', market: 'Uganda', time: new Date().toISOString() });

      // ── Customer payment page ────────────────────
      // ── Customer payment: RohoPay STK Push ──
      // Usage: /pay?imei=XXX  OR  /pay?code=SGXXXX
      //   → initiates a RohoPay payment for the selected installment
      if (path === '/pay' && (request.method === 'GET' || request.method === 'HEAD')) {
        const imei = url.searchParams.get('imei') || '';
        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Signal Electronics — Pay</title>
<style>
/* UNIQUE UI: Soft floating glass, deep dark theme, no magnified backgrounds */
* { box-sizing: border-box; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 0; color: #fff; min-height: 100vh; background-color: #060b14; transition: background-image 1.5s ease-in-out; background-size: auto, cover; background-position: center; background-attachment: fixed; background-repeat: no-repeat; }
.overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: radial-gradient(circle at top, rgba(6, 11, 20, 0.4), rgba(6, 11, 20, 0.95)); z-index: -1; }
.header { text-align: center; padding: 40px 20px 20px; }
.header h1 { margin: 0 0 6px; font-size: 22px; font-weight: 800; letter-spacing: 0.5px; color: #fff; }
.header p { margin: 0; font-size: 12px; color: #94a3b8; letter-spacing: 1px; text-transform: uppercase; font-weight: 600; }
.container { max-width: 420px; margin: 0 auto; padding: 0 16px 40px; }

/* Floating Glass Cards */
.glass-card { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 28px; padding: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); margin-bottom: 20px; position: relative; overflow: hidden; }
.glass-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent); }

.label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 12px; font-weight: 700; }
.balance { font-size: 42px; font-weight: 800; color: #fff; margin: 0; letter-spacing: -1px; }

.deposit-box { background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); padding: 16px; border-radius: 16px; margin-top: 16px; display: flex; justify-content: space-between; align-items: center; }
.deposit-box .label { color: #60a5fa; margin-bottom: 0; }
.deposit-box .val { font-size: 18px; font-weight: 700; color: #60a5fa; }

.progress-wrap { font-size: 13px; color: #cbd5e1; line-height: 1.6; margin-top: 20px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.05); }

.mode-btn { display: block; width: 100%; padding: 18px; margin-bottom: 12px; border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 18px; background: rgba(255, 255, 255, 0.02); text-align: left; cursor: pointer; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); color: #fff; position: relative; }
.mode-btn.selected { border-color: #3b82f6; background: rgba(59, 130, 246, 0.1); box-shadow: 0 0 20px rgba(59, 130, 246, 0.15); }
.mode-btn strong { display: block; font-size: 15px; margin-bottom: 6px; color: #fff; font-weight: 700; }
.mode-btn span { font-size: 13px; color: #94a3b8; }

.input-group { margin-top: 16px; display: none; }
.input-group.active { display: block; animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
.input-field { width: 100%; padding: 18px; border: 2px solid rgba(255,255,255,0.08); border-radius: 16px; background: rgba(0,0,0,0.3); color: #fff; font-size: 20px; font-weight: 700; text-align: center; font-family: inherit; outline: none; transition: border 0.2s; }
.input-field:focus { border-color: #3b82f6; background: rgba(59, 130, 246, 0.05); }
.hint { font-size: 12px; color: #60a5fa; text-align: center; margin-top: 10px; font-weight: 500;}

.pay-btn { display: block; width: 100%; padding: 20px; border: none; border-radius: 18px; background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; font-size: 17px; font-weight: 800; cursor: pointer; margin-top: 10px; transition: transform 0.1s, opacity 0.2s; box-shadow: 0 10px 20px rgba(37, 99, 235, 0.3); }
.pay-btn:active { transform: scale(0.97); }
.pay-btn:disabled { opacity: 0.7; cursor: not-allowed; }

/* ELEGANT HELP CONTACT */
.help-card { text-align: center; padding: 24px; background: transparent; border: 1px dashed rgba(255,255,255,0.15); }
.help-title { font-size: 13px; color: #94a3b8; margin-bottom: 12px; }
.help-phone { display: inline-flex; align-items: center; justify-content: center; gap: 10px; background: rgba(255,255,255,0.05); padding: 14px 24px; border-radius: 50px; color: #fff; text-decoration: none; font-weight: 700; font-size: 16px; border: 1px solid rgba(255,255,255,0.1); transition: all 0.2s; }
.help-phone:active { background: rgba(59, 130, 246, 0.2); border-color: #3b82f6; }
.help-icon { font-size: 18px; }

.loader { display: inline-block; width: 18px; height: 18px; border: 3px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 10px; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="overlay"></div>
<div class="header">
  <h1>Signal Electronics</h1>
  <p>Device Financing</p>
</div>
<div class="container">
  
  <div class="glass-card">
    <div class="label">Outstanding Balance</div>
    <div class="balance" id="balance">Loading…</div>
    
    <div id="deposit-section" style="display:none;">
      <div class="deposit-box">
        <div class="label">Initial Deposit Required</div>
        <div class="val" id="deposit-val">—</div>
      </div>
    </div>

    <div class="progress-wrap" id="progress-wrap" style="display: none;"></div>
  </div>

  <div class="glass-card" id="pay-options" style="display: none;">
    <div class="label">Select Payment Type</div>

    <button class="mode-btn selected" onclick="selectMode('single', this)">
      <strong id="single-title">Pay Next Installment</strong>
      <span id="single-desc">—</span>
    </button>

    <button class="mode-btn" onclick="selectMode('custom', this)">
      <strong>Pay Custom Amount</strong>
      <span>Enter any amount above 500 UGX.</span>
    </button>

    <button class="mode-btn" onclick="selectMode('full', this)">
      <strong>Clear Full Balance</strong>
      <span id="full-desc">—</span>
    </button>

    <div class="input-group" id="custom-group">
      <input type="number" id="custom-amount" class="input-field" min="500" step="100" oninput="updateSummary()" placeholder="Amount in UGX">
      <div class="hint" id="coverage-hint"></div>
    </div>

    <div class="input-group active" id="phone-group" style="margin-top: 24px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 24px;">
      <div class="label" style="color: #fff;">Mobile Money Number</div>
      <input type="tel" id="phone-number" class="input-field" placeholder="07XX XXX XXX" style="text-align: left; font-size: 18px; letter-spacing: 2px;">
      <div class="hint" style="text-align: left; color: #94a3b8; margin-top: 8px;">STK Push will be sent here.</div>
    </div>

    <button class="pay-btn" id="pay-btn" onclick="startPayment()" style="margin-top: 24px;">Pay Now</button>
  </div>

  <!-- NEW ELEGANT HELP SECTION -->
  <div class="glass-card help-card">
    <div class="help-title">Need assistance with your payment?</div>
    <a href="tel:+256706352822" class="help-phone">
      <span class="help-icon">📞</span> +256 706 352 822
    </a>
  </div>

</div>

<script>
const IMEI = ${JSON.stringify(imei)};
let currentMode = 'single';
let schedules = [];

// Background gallery: NATURAL SIZE, NO MAGNIFICATION
const IMAGES = [
  'https://device-finance-api.whiteghostpheonix.workers.dev/media/static/bg1.png',
  'https://device-finance-api.whiteghostpheonix.workers.dev/media/static/bg2.jpg',
  'https://device-finance-api.whiteghostpheonix.workers.dev/media/static/bg3.jpg',
  'https://device-finance-api.whiteghostpheonix.workers.dev/media/static/bg4.jpg',
  'https://device-finance-api.whiteghostpheonix.workers.dev/media/static/bg5.jpg',
  'https://device-finance-api.whiteghostpheonix.workers.dev/media/static/bg6.jpg',
  'https://device-finance-api.whiteghostpheonix.workers.dev/media/static/bg7.jpg'
];
let idx = 0;
function rotateBg() {
  // Set background-size to 'auto' so it doesn't magnify, keeping the original image size
  document.body.style.backgroundImage = "url('" + IMAGES[idx % IMAGES.length] + "')";
  idx++;
}
if (IMAGES.length > 0) {
  IMAGES.forEach(src => { const i = new Image(); i.src = src; });
  rotateBg();
  setInterval(rotateBg, 8000);
}

function formatUGX(n) { return Math.round(n).toLocaleString(); }

async function loadSchedules() {
  try {
    const r = await fetch('/public/schedule?imei=' + encodeURIComponent(IMEI));
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    schedules = data.schedule || [];
    render();
  } catch (e) {
    document.getElementById('balance').innerText = 'Error loading data';
    document.getElementById('balance').style.color = '#ef4444';
  }
}

function render() {
  const unpaid = schedules.filter(s => s.status !== 'paid');
  const paid = schedules.filter(s => s.status === 'paid');
  const totalOwed = unpaid.reduce((sum, s) => sum + (s.amount_due_ugx - (s.amount_paid_ugx || 0)), 0);

  document.getElementById('balance').innerText = 'UGX ' + formatUGX(totalOwed);

  if (unpaid.length === 0) {
    document.getElementById('balance').innerText = 'Fully Paid';
    document.getElementById('balance').style.color = '#10b981';
    document.getElementById('pay-options').style.display = 'none';
    return;
  }

  const first = schedules[0];
  const isFirstUnpaid = first && first.status !== 'paid';
  
  if (isFirstUnpaid) {
    document.getElementById('deposit-section').style.display = 'block';
    const depOwed = first.amount_due_ugx - (first.amount_paid_ugx || 0);
    document.getElementById('deposit-val').innerText = 'UGX ' + formatUGX(depOwed);
    document.getElementById('single-title').innerText = 'Pay Initial Deposit';
    document.getElementById('single-desc').innerText = 'UGX ' + formatUGX(depOwed);
  } else {
    document.getElementById('deposit-section').style.display = 'none';
    document.getElementById('single-title').innerText = 'Pay Next Installment';
    document.getElementById('single-desc').innerText = 'UGX ' + formatUGX(unpaid[0].amount_due_ugx - (unpaid[0].amount_paid_ugx || 0));
  }

  const per = schedules[1]?.amount_due_ugx || 0;
  const progressWrap = document.getElementById('progress-wrap');
  progressWrap.style.display = 'block';
  
  if (isFirstUnpaid) {
    progressWrap.innerHTML = 'Once deposit is cleared, you will pay <strong>UGX ' + formatUGX(per) + '</strong> per installment.';
  } else {
    progressWrap.innerHTML = '<strong>' + paid.length + '</strong> of <strong>' + schedules.length + '</strong> payments cleared.<br>Recurring rate: <strong>UGX ' + formatUGX(per) + '</strong>.';
  }

  document.getElementById('full-desc').innerText = 'UGX ' + formatUGX(totalOwed) + ' (all remaining)';
  document.getElementById('pay-options').style.display = 'block';
  updateSummary();
}

function selectMode(mode, el) {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('custom-group').classList.toggle('active', mode === 'custom');
  updateSummary();
}

function computeAmount() {
  const unpaid = schedules.filter(s => s.status !== 'paid');
  if (currentMode === 'single') return Math.round(unpaid[0].amount_due_ugx - (unpaid[0].amount_paid_ugx || 0));
  if (currentMode === 'custom') return Math.round(Number(document.getElementById('custom-amount').value) || 0);
  return Math.round(unpaid.reduce((sum, s) => sum + (s.amount_due_ugx - (s.amount_paid_ugx || 0)), 0));
}

function updateSummary() {
  if (currentMode === 'custom') {
    const amount = computeAmount();
    document.getElementById('coverage-hint').innerText = amount < 500 ? 'Minimum is 500 UGX' : 'You are paying UGX ' + formatUGX(amount);
  }
}

async function startPayment() {
  const amount = computeAmount();
  const phone = document.getElementById('phone-number').value.trim();
  
  if (amount < 500) { alert('Minimum payment is 500 UGX.'); return; }
  if (!phone || phone.length < 9) { alert('Please enter a valid phone number.'); return; }

  const btn = document.getElementById('pay-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="loader"></span> Connecting…';

  const body = { device_imei: IMEI, mode: currentMode, custom_amount_ugx: amount, phone: phone };

  try {
    const r = await fetch('/public/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    
    if (data.error) throw new Error(data.error);
    
    // REDIRECT TO NEW PROCESSING PAGE
    window.location.href = '/processing?amount=' + amount + '&phone=' + encodeURIComponent(phone) + '&ref=' + data.reference + '&imei=' + IMEI;
    
  } catch (e) {
    btn.disabled = false;
    btn.innerText = 'Pay Now';
    alert('Payment failed: ' + e.message);
  }
}

loadSchedules();
</script>
</body></html>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // Public: Create order (Trigger STK Push via RohoPay)
      if (path === '/public/create-order' && request.method === 'POST') {
        const body = await request.json();
        const { device_imei, mode = 'single', custom_amount_ugx, phone } = body;
 
        if (!device_imei) return json({ error: 'device_imei required' }, 400);
 
        const device = await env.DB.prepare(
          `SELECT imei, customer_name, customer_phone, payment_code FROM devices WHERE imei = ?`
        ).bind(device_imei).first();
        if (!device) return json({ error: 'Device not found' }, 404);
 
        const unpaid = await env.DB.prepare(
          `SELECT id, installment_number, amount_due_ugx, amount_paid_ugx FROM schedules
           WHERE device_imei = ? AND status IN ('pending','overdue') ORDER BY installment_number ASC`
        ).bind(device_imei).all();
        if (!unpaid.results?.length) return json({ error: 'No outstanding balance' }, 400);
 
        const totalOwed = unpaid.results.reduce(
          (sum, s) => sum + (s.amount_due_ugx - (s.amount_paid_ugx || 0)), 0
        );
 
        let amountToCharge = 0;
 
        if (mode === 'custom') {
          const requested = Math.round(Number(custom_amount_ugx) || 0);
          if (requested < 500) return json({ error: 'Minimum payment is 500 UGX' }, 400);
          if (requested > totalOwed) {
            return json({ error: 'Maximum you can pay is ' + Math.round(totalOwed).toLocaleString() + ' UGX' }, 400);
          }
          amountToCharge = requested;
        } else if (mode === 'single') {
          amountToCharge = unpaid.results[0].amount_due_ugx - (unpaid.results[0].amount_paid_ugx || 0);
        } else if (mode === 'full') {
          amountToCharge = totalOwed;
        } else {
          return json({ error: 'Invalid mode' }, 400);
        }
 
        amountToCharge = Math.round(amountToCharge);
        if (amountToCharge < 500) return json({ error: 'Minimum payment is 500 UGX' }, 400);
 
        const merchantRef = 'SG-' + (device.payment_code || device.imei.slice(-4)) + '-' + Date.now().toString(36).toUpperCase();
        
        let rawPhone = phone || device.customer_phone || '';
        rawPhone = rawPhone.replace(/\D/g, ''); 
        if (rawPhone.startsWith('0')) rawPhone = '256' + rawPhone.slice(1);
        if (rawPhone.startsWith('7') && rawPhone.length === 9) rawPhone = '256' + rawPhone;

        if (!rawPhone || rawPhone.length < 12) {
          return json({ error: 'A valid phone number is required for RohoPay' }, 400);
        }

        const callbackUrl = url.origin + '/api/rohopay-callback?ref=' + merchantRef;

        try {
          await collectPayment(env, {
            phone: rawPhone,
            amount: amountToCharge,
            currency: 'UGX',
            description: 'Device Installment - ' + device_imei,
            callbackUrl: callbackUrl,
          });

          await env.DB.prepare(
            `INSERT INTO transactions (device_imei, amount_ugx, payment_method, reference) VALUES (?, ?, ?, ?)`
          ).bind(device_imei, amountToCharge, 'RohoPay', merchantRef).run();

          return json({ 
            success: true, 
            message: 'STK Push sent. Check your phone to enter PIN.',
            reference: merchantRef,
          });

        } catch (err) {
          console.error('RohoPay collect error:', err);
          return json({ error: err.message || 'Failed to initiate RohoPay collection' }, 500);
        }
      }

if (path === '/api/rohopay-callback' && request.method === 'POST') {
        const rawBody = await request.text();
        const signature = request.headers.get('x-rohopay-signature') || '';
        
        const isValid = await verifyRohoWebhook(env, rawBody, signature);
        if (!isValid) {
          console.warn('Invalid RohoPay webhook signature');
          return json({ error: 'Invalid signature' }, 401);
        }

        const payload = JSON.parse(rawBody);
        console.log('RohoPay webhook success:', JSON.stringify(payload));

        if (payload.event === 'deposit.successful' && payload.status === 'successful') {
          const amount = payload.amount || 0;
          const merchantRef = payload.reference;
          
          let deviceImei = null;
          if (merchantRef && merchantRef.startsWith('SG-')) {
             const parts = merchantRef.split('-');
             if (parts.length >= 2) deviceImei = parts[1];
          }

          if (deviceImei && amount > 0) {
             const unpaid = await env.DB.prepare(
              `SELECT * FROM schedules WHERE device_imei = ? AND status != 'paid' ORDER BY installment_number ASC LIMIT 1`
             ).bind(deviceImei).first();

             if (unpaid) {
                const newPaid = (unpaid.amount_paid_ugx || 0) + amount;
                const newStatus = newPaid >= unpaid.amount_due_ugx ? 'paid' : 'partial';

                await env.DB.prepare(
                  `UPDATE schedules SET amount_paid_ugx = ?, status = ? WHERE id = ?`
                ).bind(newPaid, newStatus, unpaid.id).run();

                await env.DB.prepare(
                  `UPDATE transactions SET status = 'completed' WHERE reference = ?`
                ).bind(merchantRef).run();

                await sendFcm(env, deviceImei, 'UNLOCK', { reason: 'payment_received' });
             }
          }
        }

        return json({ received: true });
      }

      // Public: Processing Confirmation Page
      // Public: Processing Confirmation Page
      if (path === '/processing' && request.method === 'GET') {
        const amount = url.searchParams.get('amount') || '0';
        const phone = url.searchParams.get('phone') || 'your phone';
        const ref = url.searchParams.get('ref') || '';
        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Processing Payment</title>
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #060b14; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; text-align: center; overflow: hidden; }
.state-container { display: none; flex-direction: column; align-items: center; animation: fadeIn 0.4s ease; width: 100%; max-width: 400px; }
.state-container.active { display: flex; }
@keyframes fadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }

/* Loading State */
.pulse-ring { width: 80px; height: 80px; border-radius: 50%; background: #3b82f6; margin: 0 auto 30px; position: relative; display: flex; align-items: center; justify-content: center; font-size: 32px; }
.pulse-ring::before { content: ''; position: absolute; width: 100%; height: 100%; border-radius: 50%; background: #3b82f6; opacity: 0.6; animation: pulse 1.5s ease-out infinite; z-index: -1; }
@keyframes pulse { 0% { transform: scale(1); opacity: 0.6; } 100% { transform: scale(1.5); opacity: 0; } }

/* Success & Error Icons */
.big-icon { font-size: 70px; margin-bottom: 20px; }
.success .big-icon { color: #10b981; }
.error .big-icon { color: #ef4444; }

h1 { font-size: 26px; margin: 0 0 12px; letter-spacing: -0.5px; }
p { color: #94a3b8; line-height: 1.6; font-size: 15px; margin: 0 0 20px; }
.amount-card { background: rgba(30, 41, 59, 0.5); border: 1px solid rgba(255,255,255,0.1); padding: 20px; border-radius: 20px; margin-bottom: 30px; width: 100%; }
.amount { font-size: 36px; font-weight: 800; color: #60a5fa; margin: 0; }
.phone { font-weight: 600; color: #fff; }
.btn { display: inline-block; padding: 16px 30px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 12px; font-weight: 700; width: 100%; border: none; font-size: 16px; }
.btn-outline { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #94a3b8; }
</style>
</head>
<body>

  <!-- STATE 1: WAITING FOR PIN / WEBHOOK -->
  <div class="state-container active" id="state-loading">
    <div class="pulse-ring">📲</div>
    <h1>Check Your Phone</h1>
    <p>We sent a PIN prompt to <span class="phone">${phone}</span>. Please enter your PIN to authorize.</p>
    <div class="amount-card">
      <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Amount</p>
      <div class="amount">UGX ${Number(amount).toLocaleString()}</div>
    </div>
    <p style="font-size: 13px; color: #64748b; margin-bottom: 20px;">Waiting for confirmation...</p>
    <button class="btn btn-outline" onclick="cancelPayment()">Cancel Payment</button>
  </div>

  <!-- STATE 2: SUCCESS -->
  <div class="state-container success" id="state-success">
    <div class="big-icon">✅</div>
    <h1>Payment Successful</h1>
    <p>Your payment of <strong>UGX ${Number(amount).toLocaleString()}</strong> has been received.</p>
    <p style="font-size: 13px;">Your device schedule has been updated.</p>
    <a href="/pay?imei=" class="btn" style="margin-top: 20px;" id="return-btn-success">Return to App</a>
  </div>

  <!-- STATE 3: ERROR / TIMEOUT -->
  <div class="state-container error" id="state-error">
    <div class="big-icon">❌</div>
    <h1>Payment Not Received</h1>
    <p>We could not confirm your payment. This usually means the PIN was cancelled or there were insufficient funds.</p>
    <a href="/pay?imei=" class="btn" style="margin-top: 20px; background: #ef4444;" id="return-btn-error">Try Again</a>
  </div>

<script>
const REF = ${JSON.stringify(ref)};
const IMEI = new URLSearchParams(window.location.search).get('imei') || '';
let pollCount = 0;
let pollInterval;

// Link the return buttons to the correct IMEI
document.getElementById('return-btn-success').href = '/pay?imei=' + IMEI;
document.getElementById('return-btn-error').href = '/pay?imei=' + IMEI;

function switchState(stateId) {
  document.querySelectorAll('.state-container').forEach(el => el.classList.remove('active'));
  document.getElementById(stateId).classList.add('active');
}

function checkStatus() {
  pollCount++;
  
  // If we've waited 60 seconds (20 polls * 3s), assume it failed/timed out
  if (pollCount > 20) {
    clearInterval(pollInterval);
    switchState('state-error');
    return;
  }

  fetch('/public/payment-status/' + REF)
    .then(res => res.json())
    .then(data => {
      if (data.status === 'completed') {
        clearInterval(pollInterval);
        switchState('state-success');
      } else if (data.status === 'failed') {
        clearInterval(pollInterval);
        switchState('state-error');
      }
      // If 'pending', do nothing, just wait for the next poll
    })
    .catch(err => console.log('Polling error', err));
}

function cancelPayment() {
  clearInterval(pollInterval);
  window.location.href = '/pay?imei=' + IMEI;
}

// Start polling every 3 seconds
if (REF) {
  pollInterval = setInterval(checkStatus, 3000);
}
</script>
</body></html>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }



      // Public: Get schedule for a specific device
      if (path === '/public/schedule' && request.method === 'GET') {
        const imei = url.searchParams.get('imei');
        if (!imei) return json({ error: 'IMEI required' }, 400);
        
        const device = await env.DB.prepare(
          `SELECT imei, customer_name, status FROM devices WHERE imei = ?`
        ).bind(imei).first();
        
        if (!device) return json({ error: 'Device not found' }, 404);

        const schedules = await env.DB.prepare(
          `SELECT id, installment_number, amount_due_ugx, amount_paid_ugx, due_date, status 
           FROM schedules WHERE device_imei = ? ORDER BY installment_number`
        ).bind(imei).all();

        return json({
          device: device,
          schedule: schedules.results || []
        });
      }

      // Public: Check payment status
      if (path.startsWith('/public/payment-status/') && request.method === 'GET') {
        const ref = path.split('/').pop();
        const txn = await env.DB.prepare(
          `SELECT status FROM transactions WHERE reference = ?`
        ).bind(ref).first();
        
        if (!txn) return json({ status: 'pending' }); // Not in DB yet
        return json({ status: txn.status }); // 'pending', 'completed', 'failed'
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
