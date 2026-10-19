/**
 * Pesapal API 3.0 client for Cloudflare Workers.
 */

const SANDBOX_BASE = 'https://cybqa.pesapal.com/pesapalv3';
const PRODUCTION_BASE = 'https://pay.pesapal.com/v3';

function getBaseUrl(env) {
  return env.PESAPAL_ENVIRONMENT === 'production' ? PRODUCTION_BASE : SANDBOX_BASE;
}

// Token cache (per Worker isolate, 5-min validity, refresh at 4 min)
let cachedToken = null;
let cachedTokenExpiry = 0;

export async function getAccessToken(env) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) return cachedToken;

  const res = await fetch(`${getBaseUrl(env)}/api/Auth/RequestToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      consumer_key: env.PESAPAL_CONSUMER_KEY,
      consumer_secret: env.PESAPAL_CONSUMER_SECRET,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Pesapal auth failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  if (!data.token) throw new Error('Pesapal auth returned no token');

  cachedToken = data.token;
  cachedTokenExpiry = now + 4 * 60 * 1000;
  return cachedToken;
}

export async function registerIpn(env, ipnUrl, notificationType = 'POST') {
  const token = await getAccessToken(env);

  const res = await fetch(`${getBaseUrl(env)}/api/URLSetup/RegisterIPN`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      url: ipnUrl,
      ipn_notification_type: notificationType,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Pesapal IPN registration failed: ${res.status} ${err}`);
  }

  return res.json();
}

export async function listIpns(env) {
  const token = await getAccessToken(env);
  const res = await fetch(`${getBaseUrl(env)}/api/URLSetup/GetIpnList`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(`Pesapal list IPNs failed: ${res.status}`);
  return res.json();
}

export async function submitOrder(env, {
  id, amount, currency, description, callbackUrl, cancellationUrl, ipnId,
  phone, email, firstName, lastName,
}) {
  const token = await getAccessToken(env);

  const body = {
    id: String(id),
    currency: currency || 'UGX',
    amount: Number(amount),
    description: description || 'Device financing installment',
    callback_url: callbackUrl,
    cancellation_url: cancellationUrl || callbackUrl,
    notification_id: ipnId,
    billing_address: {
      phone_number: phone || '',
      email_address: email || 'customer@signalelectronics.ug',
      country_code: 'UG',
      first_name: firstName || 'Customer',
      last_name: lastName || '',
    },
  };

  const res = await fetch(`${getBaseUrl(env)}/api/Transactions/SubmitOrderRequest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Pesapal submit order failed: ${res.status} ${err}`);
  }

  return res.json();
}

export async function getTransactionStatus(env, orderTrackingId) {
  const token = await getAccessToken(env);

  const res = await fetch(
    `${getBaseUrl(env)}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`,
    {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Pesapal status check failed: ${res.status} ${err}`);
  }

  return res.json();
}
