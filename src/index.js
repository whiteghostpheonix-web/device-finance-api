const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: corsHeaders });
}

async function logAudit(env, entity, entity_id, action, details) {
  await env.DB.prepare(
    `INSERT INTO audit_log (entity, entity_id, action, details) VALUES (?, ?, ?, ?)`
  ).bind(entity, String(entity_id), action,
    typeof details === 'string' ? details : JSON.stringify(details)).run();
}

async function queueCommand(env, imei, command, reason) {
  // Deduplicate: don't queue another of the same command if one is already pending
  const existing = await env.DB.prepare(
    `SELECT id FROM commands
     WHERE device_imei = ? AND command = ? AND status IN ('queued','sent')
     LIMIT 1`
  ).bind(imei, command).first();

  if (existing) {
    return { id: existing.id, deduplicated: true };
  }

  const payload = JSON.stringify({ action: command, reason, ts: Date.now() });
  const result = await env.DB.prepare(
    `INSERT INTO commands (device_imei, command, reason, status, payload)
     VALUES (?, ?, ?, 'queued', ?)`
  ).bind(imei, command, reason, payload).run();

  await logAudit(env, 'command', result.meta.last_row_id, 'queued', { imei, command, reason });
  return { id: result.meta.last_row_id, deduplicated: false };
}

async function detectOverdue(env) {
  const overdueSchedules = await env.DB.prepare(`
    SELECT s.id, s.device_imei
    FROM schedules s
    WHERE s.status = 'pending'
      AND date(s.due_date, '+' || COALESCE((
        SELECT grace_period_days FROM payment_plans p WHERE p.id = s.plan_id
      ), 3) || ' days') < date('now')
  `).all();

  const results = { marked_overdue: 0, devices_locked: 0, commands_queued: 0, commands_deduplicated: 0 };
  const touchedDevices = new Set();

  // 1. Mark schedules overdue and collect the affected devices
  for (const row of overdueSchedules.results) {
    await env.DB.prepare(`UPDATE schedules SET status = 'overdue' WHERE id = ?`)
      .bind(row.id).run();
    results.marked_overdue++;
    touchedDevices.add(row.device_imei);
  }

  // 2. For each affected device, lock once and queue one LOCK command
  for (const imei of touchedDevices) {
    const device = await env.DB.prepare(`SELECT status FROM devices WHERE imei = ?`)
      .bind(imei).first();

    if (device && device.status !== 'locked') {
      await env.DB.prepare(`UPDATE devices SET status = 'locked' WHERE imei = ?`)
        .bind(imei).run();
      results.devices_locked++;
    }

    const cmd = await queueCommand(env, imei, 'LOCK', 'overdue');
    if (cmd.deduplicated) results.commands_deduplicated++;
    else results.commands_queued++;
  }

  return results;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === '/health') {
        return json({ status: 'ok', market: 'Uganda', time: new Date().toISOString() });
      }

      // ── Devices ────────────────────────────
      if (path === '/api/devices' && request.method === 'POST') {
        const { imei, customer_name, customer_phone, fcm_token } = await request.json();
        await env.DB.prepare(
          `INSERT INTO devices (imei, customer_name, customer_phone, fcm_token) VALUES (?, ?, ?, ?)`
        ).bind(imei, customer_name, customer_phone, fcm_token || null).run();
        await logAudit(env, 'device', imei, 'created', { customer_name });
        return json({ success: true, imei });
      }

      if (path === '/api/devices' && request.method === 'GET') {
        const devices = await env.DB.prepare(
          `SELECT * FROM devices ORDER BY created_at DESC`
        ).all();
        return json(devices.results);
      }

      if (path.startsWith('/api/devices/') && request.method === 'GET') {
        const imei = path.split('/').pop();
        const device = await env.DB.prepare(`SELECT * FROM devices WHERE imei = ?`)
          .bind(imei).first();
        if (!device) return json({ error: 'Not found' }, 404);
        return json(device);
      }

      // ── Plans ──────────────────────────────
      if (path === '/api/plans' && request.method === 'POST') {
        const { plan_name, total_amount_ugx, installment_count, grace_period_days } = await request.json();
        const result = await env.DB.prepare(
          `INSERT INTO payment_plans (plan_name, total_amount_ugx, installment_count, grace_period_days) VALUES (?, ?, ?, ?)`
        ).bind(plan_name, total_amount_ugx, installment_count, grace_period_days || 3).run();
        await logAudit(env, 'plan', result.meta.last_row_id, 'created', { plan_name });
        return json({ success: true, plan_id: result.meta.last_row_id });
      }

      if (path === '/api/plans' && request.method === 'GET') {
        const plans = await env.DB.prepare(
          `SELECT * FROM payment_plans ORDER BY created_at DESC`
        ).all();
        return json(plans.results);
      }

      // ── Assign plan (installments rounded to whole UGX) ──
      if (path === '/api/assign-plan' && request.method === 'POST') {
        const { imei, plan_id, start_date } = await request.json();
        const plan = await env.DB.prepare(`SELECT * FROM payment_plans WHERE id = ?`)
          .bind(plan_id).first();
        if (!plan) return json({ error: 'Plan not found' }, 404);

        const n = plan.installment_count;
        const total = Math.round(plan.total_amount_ugx);
        const base = Math.floor(total / n);
        const remainder = total - base * n; // assign to last installment

        const start = new Date(start_date || Date.now());
        const statements = [];
        for (let i = 0; i < n; i++) {
          const amount = (i === n - 1) ? base + remainder : base;
          const dueDate = new Date(start);
          dueDate.setMonth(dueDate.getMonth() + i);
          statements.push(
            env.DB.prepare(
              `INSERT INTO schedules (device_imei, plan_id, installment_number, due_date, amount_due_ugx)
               VALUES (?, ?, ?, ?, ?)`
            ).bind(imei, plan_id, i + 1, dueDate.toISOString().split('T')[0], amount)
          );
        }
        await env.DB.batch(statements);
        await logAudit(env, 'device', imei, 'plan_assigned', { plan_id, installments: n, total });
        return json({ success: true, installments_created: n, installment_amount: base, last_installment: base + remainder });
      }

      // ── Schedules ──────────────────────────
      if (path.startsWith('/api/schedules/') && request.method === 'GET') {
        const imei = path.split('/').pop();
        const schedules = await env.DB.prepare(
          `SELECT * FROM schedules WHERE device_imei = ? ORDER BY installment_number`
        ).bind(imei).all();
        return json(schedules.results);
      }

      // ── Manual overdue trigger ─────────────
      if (path === '/api/admin/run-overdue-check' && request.method === 'POST') {
        const result = await detectOverdue(env);
        return json({ success: true, ...result });
      }

      // ── Manual lock / unlock ───────────────
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

      // ── Command queue ──────────────────────
      if (path === '/api/commands' && request.method === 'GET') {
        const status = url.searchParams.get('status');
        const q = status
          ? env.DB.prepare(`SELECT * FROM commands WHERE status = ? ORDER BY created_at DESC LIMIT 100`).bind(status)
          : env.DB.prepare(`SELECT * FROM commands ORDER BY created_at DESC LIMIT 100`);
        const commands = await q.all();
        return json(commands.results);
      }

      // ── Record payment ─────────────────────
      if (path === '/api/payments' && request.method === 'POST') {
        const { schedule_id, amount_ugx, payment_method, reference } = await request.json();
        if (!schedule_id || !amount_ugx) return json({ error: 'schedule_id and amount_ugx required' }, 400);

        const schedule = await env.DB.prepare(`SELECT * FROM schedules WHERE id = ?`)
          .bind(schedule_id).first();
        if (!schedule) return json({ error: 'Schedule not found' }, 404);

        const newPaid = (schedule.amount_paid_ugx || 0) + Number(amount_ugx);
        const newStatus = newPaid >= schedule.amount_due_ugx ? 'paid' : schedule.status;

        await env.DB.prepare(
          `UPDATE schedules SET amount_paid_ugx = ?, status = ? WHERE id = ?`
        ).bind(newPaid, newStatus, schedule_id).run();

        await env.DB.prepare(
          `INSERT INTO transactions (schedule_id, amount_ugx, payment_method, reference) VALUES (?, ?, ?, ?)`
        ).bind(schedule_id, amount_ugx, payment_method || 'unknown', reference || null).run();

        await logAudit(env, 'schedule', schedule_id, 'payment_recorded',
          { amount_ugx, payment_method, reference });

        // Unlock when no pending/overdue schedules remain for this device
        const remaining = await env.DB.prepare(
          `SELECT COUNT(*) as cnt FROM schedules WHERE device_imei = ? AND status IN ('pending','overdue')`
        ).bind(schedule.device_imei).first();

        let unlocked = false;
        if (remaining.cnt === 0) {
          await env.DB.prepare(`UPDATE devices SET status = 'active' WHERE imei = ?`)
            .bind(schedule.device_imei).run();
          await queueCommand(env, schedule.device_imei, 'UNLOCK', 'payment_received');
          unlocked = true;
        }

        return json({
          success: true,
          schedule_status: newStatus,
          device_unlocked: unlocked,
          remaining_installments: remaining.cnt,
        });
      }

      // ── Audit ──────────────────────────────
      if (path === '/api/audit' && request.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 100);
        const rows = await env.DB.prepare(
          `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`
        ).bind(limit).all();
        return json(rows.results);
      }

      return json({ error: 'Not found', path }, 404);
    } catch (error) {
      return json({ error: error.message }, 500);
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
