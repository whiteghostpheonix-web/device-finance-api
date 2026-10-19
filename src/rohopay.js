export async function collectPayment(env, { phone, amount, currency = "UGX", description, callbackUrl }) {
  // PRODUCTION URL ONLY
  const url = "https://api.rohopay.com/api/v1/collect"; 
  
  const payload = {
    phone: phone,
    amount: amount,
    currency: currency,
    description: description,
    callback_url: callbackUrl
  };

  const headers = {
    'Authorization': `Bearer ${env.ROHOPAY_API_KEY}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID()
  };

  console.log(`PROD: Sending STK Push to ${phone} for ${amount} UGX via RohoPay`);
  
  const response = await fetch.bind(globalThis)(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`RohoPay Live Error (${response.status}):`, errorText);
    throw new Error(`RohoPay API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  console.log("RohoPay Live Success:", data);
  return data;
}

export async function verifyRohoWebhook(env, rawBody, signature) {
  if (!signature) return false;
  const secret = env.ROHOPAY_WEBHOOK_SECRET;
  if (!secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const expectedHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  const expectedSignature = "sha256=" + expectedHex;

  if (signature.length !== expectedSignature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return mismatch === 0;
}
