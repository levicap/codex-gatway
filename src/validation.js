import { normalizeWebsite } from "./company.js";
import { validateCallbackTargetInput } from "./callback.js";

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

function normalizeHttpUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function checkLength(errors, label, value, maximum) {
  if (value.length > maximum) errors.push(`${label} must be at most ${maximum.toLocaleString("en-US")} characters.`);
}

export function validateResearchRequest(body, options = {}) {
  const errors = [];
  if (!isPlainObject(body)) {
    return { ok: false, errors: ["Request body must be a JSON object."] };
  }

  const companyName = firstString(body, ["companyName", "company_name", "company"]);
  const personName = firstString(body, ["personName", "person_name", "clientName", "client_name", "client"]);
  const location = firstString(body, ["location"]);
  const jobTitle = firstString(body, ["jobTitle", "job_title"]);
  const jobDescription = firstString(body, ["jobDescription", "job_description", "description"]);
  const jobUrlRaw = firstString(body, ["jobUrl", "job_url"]);
  const callbackUrlRaw = firstString(body, ["callbackUrl", "callback_url", "callback"]);
  const websiteRaw = firstString(body, ["companyWebsite", "company_website", "website", "domain"]);
  const companyWebsite = websiteRaw ? normalizeWebsite(websiteRaw) : "";
  const jobUrl = jobUrlRaw ? normalizeHttpUrl(jobUrlRaw) : "";

  if (!companyName && !companyWebsite && !personName) {
    errors.push("At least one of companyName, companyWebsite, or personName is required.");
  }
  if (websiteRaw && !companyWebsite) errors.push("companyWebsite must be a valid HTTP(S) URL or domain.");
  if (jobUrlRaw && !jobUrl) errors.push("jobUrl must be a valid HTTP(S) URL.");

  checkLength(errors, "companyName", companyName, 500);
  checkLength(errors, "personName", personName, 500);
  checkLength(errors, "location", location, 500);
  checkLength(errors, "jobTitle", jobTitle, 1000);
  checkLength(errors, "jobDescription", jobDescription, 20000);
  checkLength(errors, "jobUrl", jobUrlRaw, 4096);

  const metadata = body.metadata === undefined ? {} : body.metadata;
  if (!isPlainObject(metadata)) {
    errors.push("metadata must be an object when provided.");
  } else if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 16 * 1024) {
    errors.push("metadata must be at most 16 KB.");
  }

  let callbackUrl = "";
  if (callbackUrlRaw) {
    if (options.callbackSecretConfigured === false) {
      errors.push("Callbacks are disabled until CALLBACK_SECRET is configured.");
    }
    const callbackCheck = validateCallbackTargetInput(callbackUrlRaw, options.callbackAllowedHosts || []);
    if (!callbackCheck.ok) errors.push(callbackCheck.error);
    else callbackUrl = callbackCheck.url;
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      companyName,
      companyWebsite,
      personName,
      location,
      jobTitle,
      jobDescription,
      jobUrl,
      callbackUrl,
      metadata
    }
  };
}

// Temporary source compatibility for code that imported the old name.
export const validateEnrichmentRequest = validateResearchRequest;

export function validateIdempotencyKey(value) {
  if (value === undefined || value === null || value === "") return { ok: true, value: "" };
  const key = String(value).trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) {
    return {
      ok: false,
      error: "Idempotency-Key must be 1-200 characters using letters, numbers, dot, underscore, colon, or hyphen."
    };
  }
  return { ok: true, value: key };
}
