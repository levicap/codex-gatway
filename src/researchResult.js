import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import {
  cleanDomain,
  domainFromWebsite,
  normalizeWebsite,
  pickCompanyWebsite
} from "./company.js";

const schema = JSON.parse(
  readFileSync(new URL("../schemas/decision-maker-research.schema.json", import.meta.url), "utf8")
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function isLinkedInHost(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return host === "linkedin.com";
}

function isNonLinkedInHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !isLinkedInHost(url.hostname);
  } catch {
    return false;
  }
}

export function canonicalizeLinkedInUrl(value) {
  if (!value || typeof value !== "string") return "";

  try {
    const candidate = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
    const url = new URL(candidate);
    if (!isLinkedInHost(url.hostname)) return "";

    const match = url.pathname.match(/^\/in\/([^/?#]+)\/?$/i);
    if (!match || !match[1]) return "";

    const slug = decodeURIComponent(match[1]).trim();
    if (!slug || /[\s/?#\\]/.test(slug)) return "";
    return `https://www.linkedin.com/in/${encodeURIComponent(slug).replaceAll("%2D", "-")}`;
  } catch {
    return "";
  }
}

export function parseJsonObject(raw, label = "Agent response") {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error(`${label} was empty.`);

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) return JSON.parse(fenced[1]);

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
  }

  throw new Error(`${label} was not valid JSON.`);
}

function schemaErrors() {
  return (validateSchema.errors || []).map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message}`.trim();
  });
}

export function validateAndNormalizeResearch(value) {
  if (!validateSchema(value)) {
    return { ok: false, errors: schemaErrors() };
  }

  const errors = [];
  const seenProfiles = new Set();
  const decisionMakers = [];
  const resolvedCompanyName = value.resolvedCompanyName.trim();
  const targetSourceUrls = uniqueStrings(value.sourceUrls);
  const warnings = uniqueStrings(value.warnings);

  for (const sourceUrl of targetSourceUrls) {
    if (!isNonLinkedInHttpUrl(sourceUrl)) {
      errors.push("/sourceUrls must contain only non-LinkedIn HTTP(S) URLs");
      break;
    }
  }

  for (const [index, candidate] of value.decisionMakers.entries()) {
    const name = candidate.name.trim();
    const title = candidate.title.trim();
    const company = candidate.company.trim();
    const relevanceReason = candidate.relevanceReason.trim();
    const linkedinUrl = canonicalizeLinkedInUrl(candidate.linkedinUrl);
    const sourceUrls = uniqueStrings(candidate.sourceUrls);
    const linkedinEvidenceUrls = uniqueStrings(candidate.linkedinEvidenceUrls);

    for (const [field, fieldValue] of Object.entries({ name, title, company, relevanceReason })) {
      if (!fieldValue) errors.push(`/decisionMakers/${index}/${field} must not be blank`);
    }
    if (!name || !title || !company || !relevanceReason) continue;
    if (!linkedinUrl) {
      errors.push(`/decisionMakers/${index}/linkedinUrl is not a canonical LinkedIn profile URL`);
      continue;
    }
    if (!sourceUrls.some(isNonLinkedInHttpUrl)) {
      errors.push(`/decisionMakers/${index}/sourceUrls needs a non-LinkedIn HTTP source`);
      continue;
    }
    if (sourceUrls.some((item) => {
      try {
        return !["http:", "https:"].includes(new URL(item).protocol);
      } catch {
        return true;
      }
    })) {
      errors.push(`/decisionMakers/${index}/sourceUrls must contain only HTTP(S) URLs`);
      continue;
    }
    if (linkedinEvidenceUrls.some((item) => {
      try {
        return !["http:", "https:"].includes(new URL(item).protocol);
      } catch {
        return true;
      }
    })) {
      errors.push(`/decisionMakers/${index}/linkedinEvidenceUrls must contain only HTTP(S) URLs`);
      continue;
    }
    if (!linkedinEvidenceUrls.some((item) => item === linkedinUrl || canonicalizeLinkedInUrl(item) === linkedinUrl)) {
      errors.push(`/decisionMakers/${index}/linkedinEvidenceUrls does not tie to the LinkedIn profile`);
      continue;
    }
    if (seenProfiles.has(linkedinUrl)) {
      errors.push(`/decisionMakers/${index}/linkedinUrl duplicates another candidate`);
      continue;
    }

    seenProfiles.add(linkedinUrl);
    decisionMakers.push({
      name,
      title,
      company,
      linkedinUrl,
      confidence: candidate.confidence,
      relevanceReason,
      sourceUrls,
      linkedinEvidenceUrls
    });
  }

  if (decisionMakers.length && !resolvedCompanyName) {
    errors.push("/resolvedCompanyName is required when decisionMakers are returned");
  }
  if (warnings.includes("ambiguous_target") && (decisionMakers.length || resolvedCompanyName)) {
    errors.push("ambiguous_target requires an empty target name and no decisionMakers");
  }
  if (errors.length) return { ok: false, errors };

  const website = normalizeWebsite(value.website);
  const domain = cleanDomain(value.domain) || cleanDomain(website);
  return {
    ok: true,
    value: {
      resolvedCompanyName,
      website,
      domain,
      confidence: value.confidence,
      sourceUrls: targetSourceUrls,
      decisionMakers,
      warnings
    }
  };
}

export function buildTerminalResult({ jobId, input, research, run }) {
  const returned = research.decisionMakers.length;
  const website = pickCompanyWebsite(input.companyWebsite, research.website, research.domain);
  return {
    jobId,
    status: "completed",
    target: {
      resolvedCompanyName: research.resolvedCompanyName,
      website,
      domain: domainFromWebsite(website) || research.domain,
      confidence: research.confidence,
      sourceUrls: research.sourceUrls
    },
    decisionMakers: research.decisionMakers,
    coverage: {
      requested: 3,
      returned,
      status: returned === 3 ? "complete" : returned > 0 ? "partial" : "none"
    },
    research: {
      model: run.model,
      toolsUsed: run.toolsUsed,
      browserUsed: run.browserUsed,
      durationMs: run.durationMs,
      warnings: research.warnings
    },
    metadata: input.metadata
  };
}
