export const DEFAULT_EXECUTIVE_TITLES = [
  "Chief Executive Officer",
  "CEO",
  "Founder",
  "Co-Founder",
  "President",
  "Owner",
  "Managing Director",
  "Chairman",
  "Chief Operating Officer",
  "COO",
  "Chief Financial Officer",
  "CFO",
  "Chief Technology Officer",
  "CTO",
  "Chief Marketing Officer",
  "CMO",
  "Chief Revenue Officer",
  "CRO",
  "Chief Commercial Officer",
  "Vice President",
  "VP",
  "Head of"
];

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

export function executiveRank(title = "") {
  const lower = title.toLowerCase();
  if (/\b(chief executive officer|ceo|founder|co-founder|president|owner|chair|chairman)\b/.test(lower)) return 10;
  if (/\bchief\b|\b(cfo|coo|cto|cmo|cro|cio|ciso|cco)\b/.test(lower)) return 9;
  if (/\bmanaging director\b/.test(lower)) return 8;
  if (/\b(vice president|vp|head of|global head|general manager)\b/.test(lower)) return 7;
  if (/\bdirector\b/.test(lower)) return 5;
  return 1;
}

export function normalizeExecutiveName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function hasFullName(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length >= 2;
}

function executiveScore(executive) {
  const source = String(executive.source || "");
  const email = cleanEmail(executive.email);
  const sourceBonus = source.includes("codex_public") ? 25 : 0;
  const emailBonus = email ? 125 : 0;
  const linkedinBonus = cleanString(executive.linkedinUrl) ? 3 : 0;
  const nameBonus = hasFullName(executive.name) ? 2 : 0;
  const apolloOnlyNoEmailPenalty = !source.includes("codex_public") && !email ? -150 : 0;
  return executiveRank(executive.title) * 100 + sourceBonus + emailBonus + linkedinBonus + nameBonus + apolloOnlyNoEmailPenalty;
}

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function cleanString(value) {
  return String(value || "").trim();
}

export function mergeExecutives({ apolloExecutives = [], publicExecutives = [], limit = 10 }) {
  const merged = new Map();

  for (const executive of publicExecutives) {
    const name = String(executive.name || "").trim();
    const title = String(executive.title || "").trim();
    if (!name || !title) continue;

    const key = normalizeExecutiveName(name);
    const email = cleanEmail(executive.email);
    const emailSource = email ? cleanString(executive.emailSource) || "codex_public" : "";
    merged.set(key, {
      name,
      title,
      email,
      emailType: cleanString(executive.emailType),
      emailSource,
      emailSourceUrls: Array.isArray(executive.emailSourceUrls) ? executive.emailSourceUrls.filter(Boolean) : [],
      source: "codex_public",
      confidence: Number(executive.confidence || 0.5),
      sourceUrls: Array.isArray(executive.sourceUrls) ? executive.sourceUrls.filter(Boolean) : []
    });
  }

  for (const executive of apolloExecutives) {
    const name = String(executive.name || "").trim();
    const title = String(executive.title || "").trim();
    if (!name || !title) continue;
    if (!hasFullName(name) && !cleanEmail(executive.email) && !cleanString(executive.linkedinUrl)) continue;

    const key = normalizeExecutiveName(name);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        ...executive,
        email: cleanEmail(executive.email),
        emailType: cleanEmail(executive.email) ? cleanString(executive.emailType || "apollo") : "",
        emailSource: cleanEmail(executive.email) ? "apollo" : "",
        emailSourceUrls: [],
        source: "apollo",
        sourceUrls: []
      });
      continue;
    }

    const currentEmail = cleanEmail(current.email);
    const apolloEmail = cleanEmail(executive.email);
    merged.set(key, {
      ...current,
      ...executive,
      email: currentEmail || apolloEmail,
      emailType: currentEmail ? current.emailType : apolloEmail ? cleanString(executive.emailType || "apollo") : "",
      emailSource: currentEmail ? current.emailSource || "codex_public" : apolloEmail ? "apollo" : "",
      emailSourceUrls: currentEmail ? current.emailSourceUrls || [] : [],
      source: "apollo+codex_public",
      confidence: Math.max(Number(current.confidence || 0.5), Number(executive.confidence || 0.8)),
      sourceUrls: current.sourceUrls || []
    });
  }

  return [...merged.values()]
    .sort((a, b) => executiveScore(b) - executiveScore(a) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
