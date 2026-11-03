export async function handleAdminPlansRoute(request, env, json) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/plans') return null;

  if (request.method === 'GET') {
    const result = await env.DB.prepare(`
      SELECT id, plan_name, frequency, period_type, period_count,
             amount_per_period, total_amount_ugx, installment_count,
             grace_period_days, notes, has_deposit, deposit_amount, deposit_due_days
      FROM payment_plans
      ORDER BY id DESC
    `).all();
    return json(result.results || []);
  }

  if (request.method !== 'POST') return null;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const planName = String(body.plan_name || '').trim().slice(0, 120);
  const frequency = String(body.frequency || '').trim().toLowerCase();
  const amountPerPeriod = Number(body.amount_per_period);
  const periodCount = Number(body.period_count);
  const gracePeriodDays = Number(body.grace_period_days ?? 3);
  const hasDeposit = body.has_deposit === true || body.has_deposit === 1;
  const depositAmount = hasDeposit ? Number(body.deposit_amount || 0) : 0;
  const depositDueDays = hasDeposit ? Number(body.deposit_due_days || 0) : 0;
  const notes = String(body.notes || '').trim().slice(0, 2000);

  if (!planName) return json({ error: 'Plan name is required' }, 400);
  if (!['daily', 'weekly', 'monthly'].includes(frequency)) return json({ error: 'Frequency must be daily, weekly, or monthly' }, 400);
  if (!Number.isFinite(amountPerPeriod) || amountPerPeriod <= 0) return json({ error: 'Amount per period must be greater than zero' }, 400);
  if (!Number.isInteger(periodCount) || periodCount < 1 || periodCount > 2000) return json({ error: 'Period count must be between 1 and 2000' }, 400);
  if (!Number.isInteger(gracePeriodDays) || gracePeriodDays < 0 || gracePeriodDays > 365) return json({ error: 'Grace period must be between 0 and 365 days' }, 400);
  if (!Number.isFinite(depositAmount) || depositAmount < 0 || !Number.isInteger(depositDueDays) || depositDueDays < 0 || depositDueDays > 365) {
    return json({ error: 'Deposit amount or due days are invalid' }, 400);
  }

  const totalAmount = amountPerPeriod * periodCount + depositAmount;
  const result = await env.DB.prepare(`
    INSERT INTO payment_plans (
      plan_name, total_amount_ugx, installment_count, grace_period_days,
      frequency, period_type, period_count, amount_per_period,
      has_deposit, deposit_amount, deposit_due_days, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    planName, totalAmount, periodCount, gracePeriodDays,
    frequency, frequency, periodCount, amountPerPeriod,
    hasDeposit ? 1 : 0, depositAmount, depositDueDays, notes,
  ).run();

  return json({
    success: true,
    id: result.meta.last_row_id,
    plan_name: planName,
    frequency,
    period_count: periodCount,
    amount_per_period: amountPerPeriod,
    total_amount_ugx: totalAmount,
  }, 201);
}
