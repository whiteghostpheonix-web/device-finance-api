export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === '/health') {
        return Response.json({ status: 'ok', market: 'Uganda' }, { headers: corsHeaders });
      }

      if (path === '/api/devices' && request.method === 'POST') {
        const body = await request.json();
        const { imei, customer_name, customer_phone, fcm_token } = body;
        await env.DB.prepare(
          `INSERT INTO devices (imei, customer_name, customer_phone, fcm_token) VALUES (?, ?, ?, ?)`
        ).bind(imei, customer_name, customer_phone, fcm_token || null).run();
        return Response.json({ success: true, imei }, { headers: corsHeaders });
      }

      if (path === '/api/devices' && request.method === 'GET') {
        const devices = await env.DB.prepare(
          `SELECT * FROM devices ORDER BY created_at DESC`
        ).all();
        return Response.json(devices.results, { headers: corsHeaders });
      }

      if (path === '/api/plans' && request.method === 'POST') {
        const body = await request.json();
        const { plan_name, total_amount_ugx, installment_count, grace_period_days } = body;
        const result = await env.DB.prepare(
          `INSERT INTO payment_plans (plan_name, total_amount_ugx, installment_count, grace_period_days)
           VALUES (?, ?, ?, ?)`
        ).bind(plan_name, total_amount_ugx, installment_count, grace_period_days || 3).run();
        return Response.json({ success: true, plan_id: result.meta.last_row_id }, { headers: corsHeaders });
      }

      if (path === '/api/plans' && request.method === 'GET') {
        const plans = await env.DB.prepare(
          `SELECT * FROM payment_plans ORDER BY created_at DESC`
        ).all();
        return Response.json(plans.results, { headers: corsHeaders });
      }

      if (path === '/api/assign-plan' && request.method === 'POST') {
        const body = await request.json();
        const { imei, plan_id, start_date } = body;

        const plan = await env.DB.prepare(
          `SELECT * FROM payment_plans WHERE id = ?`
        ).bind(plan_id).first();

        if (!plan) {
          return Response.json({ error: 'Plan not found' }, { status: 404, headers: corsHeaders });
        }

        const installmentAmount = plan.total_amount_ugx / plan.installment_count;
        const start = new Date(start_date || Date.now());

        const statements = [];
        for (let i = 0; i < plan.installment_count; i++) {
          const dueDate = new Date(start);
          dueDate.setMonth(dueDate.getMonth() + i);
          statements.push(
            env.DB.prepare(
              `INSERT INTO schedules (device_imei, plan_id, installment_number, due_date, amount_due_ugx)
               VALUES (?, ?, ?, ?, ?)`
            ).bind(imei, plan_id, i + 1, dueDate.toISOString().split('T')[0], installmentAmount)
          );
        }

        await env.DB.batch(statements);
        return Response.json({ success: true, installments_created: plan.installment_count }, { headers: corsHeaders });
      }

      if (path.startsWith('/api/schedules/') && request.method === 'GET') {
        const imei = path.split('/').pop();
        const schedules = await env.DB.prepare(
          `SELECT * FROM schedules WHERE device_imei = ? ORDER BY installment_number`
        ).bind(imei).all();
        return Response.json(schedules.results, { headers: corsHeaders });
      }

      return Response.json({ error: 'Not found', path }, { status: 404, headers: corsHeaders });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500, headers: corsHeaders });
    }
  },
};
