import fs from 'node:fs';

const file = 'src/index.js';
let source = fs.readFileSync(file, 'utf8');
const marker = '// ADMIN_DASHBOARD_READ_ROUTES_V1';
if (source.includes(marker)) {
  console.log('Dashboard routes are already installed; no changes made.');
  process.exit(0);
}
if (!source.includes("if (path === '/health')")) {
  console.error('Expected committed API source was not found. Restore/checkout the full API source first; no changes made.');
  process.exit(1);
}

const corsLine = "  'Access-Control-Allow-Origin': '*',";
if (!source.includes(corsLine)) {
  console.error('Expected CORS configuration not found; no changes made.');
  process.exit(1);
}
source = source.replace(corsLine, "  'Access-Control-Allow-Origin': 'https://signal-dashboard.whiteghostpheonix.workers.dev',");

const routes = `      ${marker}
      // Read-only routes used by the current admin dashboard. Keep Cloudflare Access
      // enabled for this API hostname; these endpoints expose customer/finance data.
      if (path === '/api/dashboard/summary' && request.method === 'GET') {
        const stats = await env.DB.prepare(\`
          SELECT
            (SELECT COUNT(*) FROM devices) AS total_devices,
            (SELECT COUNT(*) FROM devices WHERE status = 'active') AS active_devices,
            (SELECT COUNT(*) FROM devices WHERE status = 'locked') AS locked_devices,
            (SELECT COUNT(*) FROM schedules WHERE status = 'overdue') AS overdue_schedules,
            (SELECT COUNT(*) FROM commands WHERE status = 'queued') AS pending_commands,
            COALESCE((SELECT SUM(amount_paid_ugx) FROM schedules), 0) AS total_collected_ugx
        \`).first();
        return json(stats || {});
      }

      if (path === '/api/dashboard/devices' && request.method === 'GET') {
        const rows = await env.DB.prepare(\`
          SELECT d.*,
            COALESCE(SUM(CASE WHEN s.status = 'paid' THEN 1 ELSE 0 END), 0) AS paid_count,
            COUNT(s.id) AS total_count,
            COALESCE(SUM(CASE WHEN s.status != 'paid'
              THEN s.amount_due_ugx - COALESCE(s.amount_paid_ugx, 0) ELSE 0 END), 0) AS balance_ugx,
            MIN(CASE WHEN s.status IN ('pending', 'overdue') THEN s.due_date END) AS next_due_date
          FROM devices d
          LEFT JOIN schedules s ON s.device_imei = d.imei
          GROUP BY d.imei
          ORDER BY d.created_at DESC
        \`).all();
        return json(rows.results || []);
      }

      if (path.startsWith('/api/dashboard/devices/') && request.method === 'GET') {
        const imei = decodeURIComponent(path.slice('/api/dashboard/devices/'.length));
        if (!imei || imei.includes('/')) return json({ error: 'Invalid device identifier' }, 400);
        const device = await env.DB.prepare('SELECT * FROM devices WHERE imei = ?').bind(imei).first();
        if (!device) return json({ error: 'Device not found' }, 404);
        const [schedules, commands, transactions] = await Promise.all([
          env.DB.prepare('SELECT * FROM schedules WHERE device_imei = ? ORDER BY installment_number').bind(imei).all(),
          env.DB.prepare('SELECT * FROM commands WHERE device_imei = ? ORDER BY created_at DESC LIMIT 50').bind(imei).all(),
          env.DB.prepare(\`SELECT t.* FROM transactions t
            LEFT JOIN schedules s ON s.id = t.schedule_id
            WHERE s.device_imei = ? ORDER BY t.paid_at DESC LIMIT 50\`).bind(imei).all(),
        ]);
        return json({ device, schedules: schedules.results || [], commands: commands.results || [], transactions: transactions.results || [] });
      }

      if (path === '/api/plans' && request.method === 'GET') {
        const rows = await env.DB.prepare(\`SELECT id, plan_name, total_amount_ugx, installment_count,
          grace_period_days, frequency, notes, amount_per_period, period_type, period_count,
          has_deposit, deposit_amount, deposit_due_days
          FROM payment_plans ORDER BY id DESC\`).all();
        return json(rows.results || []);
      }

      if (path === '/api/resellers' && request.method === 'GET') {
        const rows = await env.DB.prepare(\`SELECT email, name, phone, region, address, nin,
          occupation, photo_url, id_front_url, id_back_url, created_at, updated_at
          FROM resellers ORDER BY created_at DESC\`).all();
        return json(rows.results || []);
      }

`;
const healthRoute = "      if (path === '/health')";
if (!source.includes(healthRoute)) {
  console.error('Health route anchor not found; no changes made.');
  process.exit(1);
}
source = source.replace(healthRoute, routes + healthRoute);
fs.writeFileSync(file, source);
console.log('Installed read-only admin dashboard API routes and restricted CORS to the admin dashboard origin.');
console.log('No secrets or database data were read or changed. Review the diff before deployment.');
