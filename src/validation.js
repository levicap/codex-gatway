import { normalizeWebsite } from "./company.js";

function firstString(body, names) {
  for (const name of names) {
    const value = body?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonIfPossible(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeBody(body) {
  const parsed = parseJsonIfPossible(body);
  if (isPlainObject(parsed)) {
    for (const key of ["data", "body", "raw", "payload"]) {
      const nested = parseJsonIfPossible(parsed[key]);
      if (isPlainObject(nested)) return nested;
    }

    const keys = Object.keys(parsed);
    if (keys.length === 1) {
      const onlyKey = parseJsonIfPossible(keys[0]);
      if (isPlainObject(onlyKey)) return onlyKey;
    }

    return parsed;
  }

  return parsed;
}

export function validateEnrichmentRequest(body) {
  body = normalizeBody(body);
  const errors = [];
  if (!isPlainObject(body)) {
    return { ok: false, errors: ["Request body must be a JSON object."] };
  }

  const clientName = firstString(body, ["clientName", "client_name", "client"]);
  const companyName = firstString(body, ["companyName", "company_name", "company"]);
  const callbackUrl = firstString(body, ["callbackUrl", "callback_url", "callback"]);
  const rawWebsite = firstString(body, ["companyWebsite", "company_website", "website", "domain"]);
  const companyWebsite = rawWebsite ? normalizeWebsite(rawWebsite) : "";

  if (!companyName) errors.push("companyName is required.");

  let parsedCallbackUrl = null;
  if (callbackUrl) {
    try {
      parsedCallbackUrl = new URL(callbackUrl);
      if (!["http:", "https:"].includes(parsedCallbackUrl.protocol)) {
        errors.push("callbackUrl must use http or https.");
      }
    } catch {
      errors.push("callbackUrl must be a valid URL.");
    }
  }

  if (rawWebsite && !companyWebsite) {
    errors.push("companyWebsite must be a valid URL or domain.");
  }

  const rawLimit = body.limit ?? body.executiveLimit ?? body.executive_limit ?? 10;
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    errors.push("limit must be an integer between 1 and 25.");
  }

  const metadata = isPlainObject(body.metadata) ? body.metadata : {};
  if (body.metadata !== undefined && !isPlainObject(body.metadata)) {
    errors.push("metadata must be an object when provided.");
  }

  if (errors.length) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      clientName,
      companyName,
      companyWebsite,
      callbackUrl: parsedCallbackUrl ? parsedCallbackUrl.toString() : "",
      limit,
      metadata
    }
  };
}
