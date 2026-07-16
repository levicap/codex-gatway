import crypto from "node:crypto";

function signatureHeaders(payload, secret) {
  if (!secret) return {};

  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  return {
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Signature": `sha256=${signature}`
  };
}

export async function postCallback(callbackUrl, payload, config) {
  const headers = {
    "Content-Type": "application/json",
    ...signatureHeaders(payload, config.callbackSecret)
  };

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        return {
          status: "delivered",
          attempt,
          statusCode: response.status
        };
      }

      const responseText = await response.text();
      lastError = new Error(`Callback returned ${response.status}: ${responseText || response.statusText}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }

  return {
    status: "failed",
    error: lastError?.message || "Callback delivery failed."
  };
}
