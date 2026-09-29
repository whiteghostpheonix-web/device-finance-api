// FCM v1 HTTP API sender for Cloudflare Workers.
// Uses the service account JSON stored as a Worker secret.

function base64UrlEncode(input) {
  let str;
  if (typeof input === 'string') str = input;
  else str = String.fromCharCode(...new Uint8Array(input));
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importPrivateKey(pem) {
  return crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const key = await importPrivateKey(serviceAccount.private_key);
  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64UrlEncode(sigBuffer)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`FCM token exchange failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.access_token;
}

// In-memory token cache (per isolate). 55 minutes to be safe.
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getCachedAccessToken(serviceAccount) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) return cachedToken;
  cachedToken = await getAccessToken(serviceAccount);
  cachedTokenExpiry = now + 55 * 60 * 1000;
  return cachedToken;
}

export async function sendFcm(env, fcmToken, dataPayload, projectId) {
  if (!fcmToken) throw new Error('missing_fcm_token');
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const pid = projectId || sa.project_id;
  const accessToken = await getCachedAccessToken(sa);

  const body = {
    message: {
      token: fcmToken,
      data: Object.fromEntries(
        Object.entries(dataPayload).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: 'high',
        ttl: '3600s',
      },
    },
  };

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${pid}/messages:send`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FCM send failed: ${res.status} ${text}`);
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
