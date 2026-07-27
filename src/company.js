export function normalizeWebsite(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    return url.origin;
  } catch {
    return "";
  }
}

export function domainFromWebsite(value) {
  const normalized = normalizeWebsite(value);
  if (!normalized) return "";

  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch {
    return "";
  }
}

export function cleanDomain(value) {
  if (!value || typeof value !== "string") return "";
  const candidate = value.includes("://") ? domainFromWebsite(value) : value.trim().toLowerCase();
  return candidate.replace(/^www\./, "").replace(/\/.*$/, "");
}

export function pickCompanyWebsite(inputWebsite, codexWebsite, codexDomain) {
  const direct = normalizeWebsite(inputWebsite);
  if (direct) return direct;

  const fromCodexWebsite = normalizeWebsite(codexWebsite);
  if (fromCodexWebsite) return fromCodexWebsite;

  const fromDomain = cleanDomain(codexDomain);
  return fromDomain ? `https://${fromDomain}` : "";
}
