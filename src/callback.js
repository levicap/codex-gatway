import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

function matchesAllowedHost(hostname, rule) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const allowed = rule.toLowerCase().replace(/\.$/, "");
  if (allowed.startsWith("*.")) {
    const suffix = allowed.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === allowed;
}

export function isPrivateAddress(address) {
  if (!net.isIP(address)) return true;

  if (net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    return (
      octets[0] === 0 ||
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) ||
      octets[0] >= 224
    );
  }

  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateAddress(normalized.slice("::ffff:".length));
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    /^fe[c-f]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

export function validateCallbackTargetInput(callbackUrl, allowedHosts) {
  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    return { ok: false, error: "callbackUrl must be a valid URL." };
  }

  if (url.protocol !== "https:") {
    return { ok: false, error: "callbackUrl must use HTTPS." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "callbackUrl must not contain credentials." };
  }
  if (!allowedHosts.length) {
    return { ok: false, error: "Callbacks are disabled until CALLBACK_ALLOWED_HOSTS is configured." };
  }
  if (!allowedHosts.some((rule) => matchesAllowedHost(url.hostname, rule))) {
    return { ok: false, error: "callbackUrl host is not in CALLBACK_ALLOWED_HOSTS." };
  }
  const literalHostname = url.hostname.replace(/^\[|\]$/g, "");
  if (literalHostname === "localhost" || net.isIP(literalHostname) && isPrivateAddress(literalHostname)) {
    return { ok: false, error: "callbackUrl must not target a private, loopback, or link-local address." };
  }

  url.hash = "";
  return { ok: true, url: url.toString() };
}

export function signatureHeaders(serializedBody, secret, now = Date.now()) {
  if (!secret) return {};
  const timestamp = String(Math.floor(now / 1000));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${serializedBody}`)
    .digest("hex");

  return {
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Signature": `sha256=${signature}`
  };
}

async function resolvePublicAddresses(hostname) {
  const addresses = await dns.lookup(hostname.replace(/^\[|\]$/g, ""), { all: true, verbatim: true });
  if (!addresses.length) throw new Error("Callback hostname did not resolve.");
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Callback hostname resolved to a private, loopback, or link-local address.");
  }
  return addresses;
}

async function sendOnce(callbackUrl, body, headers, timeoutMs) {
  const url = new URL(callbackUrl);
  const addresses = await resolvePublicAddresses(url.hostname);

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers
        },
        timeout: timeoutMs,
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }
      },
      (response) => {
        let received = 0;
        response.on("data", (chunk) => {
          received += chunk.length;
          if (received > 64 * 1024) request.destroy(new Error("Callback response exceeded 64 KB."));
        });
        response.on("end", () => resolve(response.statusCode || 0));
      }
    );

    request.on("timeout", () => request.destroy(new Error("Callback request timed out.")));
    request.on("error", reject);
    request.end(body);
  });
}

export async function postCallback(callbackUrl, payload, config, onAttempt = () => {}) {
  const validation = validateCallbackTargetInput(callbackUrl, config.callbackAllowedHosts);
  if (!validation.ok) return { status: "failed", error: validation.error };

  const body = JSON.stringify(payload);
  const headers = signatureHeaders(body, config.callbackSecret);
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const statusCode = await sendOnce(validation.url, body, headers, config.callbackTimeoutMs);
      const status = statusCode >= 200 && statusCode < 300 ? "delivered" : "failed";
      await onAttempt({ attempt, status, statusCode, error: status === "failed" ? `HTTP ${statusCode}` : "" });
      if (status === "delivered") return { status, attempt, statusCode };
      lastError = new Error(`Callback returned HTTP ${statusCode}.`);
    } catch (error) {
      lastError = error;
      await onAttempt({ attempt, status: "failed", statusCode: null, error: error.message });
    }

    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }

  return { status: "failed", error: lastError?.message || "Callback delivery failed." };
}
