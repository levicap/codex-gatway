import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanDomain,
  domainFromWebsite,
  mergeExecutives,
  normalizeWebsite,
  pickCompanyWebsite
} from "../src/company.js";
import { extractLeadTitles } from "../src/leadContext.js";
import { validateEnrichmentRequest } from "../src/validation.js";

test("normalizes websites and domains", () => {
  assert.equal(normalizeWebsite("openai.com/about"), "https://openai.com");
  assert.equal(normalizeWebsite("https://www.openai.com/about"), "https://www.openai.com");
  assert.equal(domainFromWebsite("https://www.openai.com/about"), "openai.com");
  assert.equal(cleanDomain("https://www.openai.com/about"), "openai.com");
});

test("prefers input website over codex website", () => {
  assert.equal(
    pickCompanyWebsite("example.com", "https://openai.com", "openai.com"),
    "https://example.com"
  );
  assert.equal(pickCompanyWebsite("", "", "openai.com"), "https://openai.com");
});

test("validates enrichment request aliases", () => {
  const result = validateEnrichmentRequest({
    client_name: "CRM",
    company_name: "OpenAI",
    website: "openai.com",
    limit: 5,
    metadata: { id: "123" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.companyWebsite, "https://openai.com");
  assert.equal(result.value.callbackUrl, "");
  assert.equal(result.value.limit, 5);
});

test("accepts optional callback URL", () => {
  const result = validateEnrichmentRequest({
    companyName: "OpenAI",
    callbackUrl: "https://example.com/callback"
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.callbackUrl, "https://example.com/callback");
});

test("accepts raw JSON string bodies", () => {
  const result = validateEnrichmentRequest(
    '{"clientName":"CRM","companyName":"OpenAI","companyWebsite":"https://openai.com","limit":5}'
  );

  assert.equal(result.ok, true);
  assert.equal(result.value.companyName, "OpenAI");
});

test("accepts JSON pasted as a single form key", () => {
  const result = validateEnrichmentRequest({
    '{"clientName":"CRM","companyName":"OpenAI","limit":5}': ""
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.companyName, "OpenAI");
});

test("rejects invalid request", () => {
  const result = validateEnrichmentRequest({
    companyName: "OpenAI",
    callbackUrl: "ftp://example.com"
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /callbackUrl must use http or https/);
});

test("rejects out-of-range limit without defaulting it", () => {
  const result = validateEnrichmentRequest({
    companyName: "OpenAI",
    limit: 0
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /limit must be an integer between 1 and 25/);
});

test("extracts lead titles from metadata", () => {
  assert.deepEqual(
    extractLeadTitles({
      jobTitle: "VP Sales",
      target: {
        roles: ["Head of Revenue", "Sales Director"]
      }
    }),
    ["VP Sales", "Head of Revenue", "Sales Director"]
  );
});

test("metadata target title can prioritize lead-relevant people", () => {
  const merged = mergeExecutives({
    limit: 2,
    metadata: {
      jobTitle: "Marketing Manager"
    },
    publicExecutives: [],
    apolloExecutives: [
      {
        name: "Casey CEO",
        title: "Chief Executive Officer",
        email: "casey@example.com",
        emailType: "apollo_work",
        confidence: 0.85
      },
      {
        name: "Morgan Marketer",
        title: "Marketing Manager",
        email: "morgan@example.com",
        emailType: "apollo_work",
        confidence: 0.85
      }
    ]
  });

  assert.equal(merged[0].name, "Morgan Marketer");
});

test("merges public and apollo executives by name and ranks senior titles first", () => {
  const merged = mergeExecutives({
    limit: 5,
    publicExecutives: [
      {
        name: "Jane Doe",
        title: "CEO",
        email: "jane@example.com",
        emailType: "public_work",
        linkedinUrl: "https://linkedin.com/in/jane-public",
        emailSourceUrls: ["https://example.com/contact"],
        confidence: 0.7,
        sourceUrls: ["https://example.com/team"]
      },
      {
        name: "Sam Smith",
        title: "Director of Sales",
        email: "",
        emailType: "",
        emailSourceUrls: [],
        confidence: 0.5,
        sourceUrls: []
      }
    ],
    apolloExecutives: [
      {
        name: "Jane Doe",
        title: "Chief Executive Officer",
        email: "jane@apollo.example",
        emailType: "apollo_work",
        linkedinUrl: "https://linkedin.com/in/janedoe",
        confidence: 0.85
      },
      {
        name: "Alex Jones",
        title: "CFO",
        email: "alex@apollo.example",
        emailType: "apollo_work",
        confidence: 0.85
      },
      {
        name: "Felix Rattner",
        title: "Founder, CTO",
        email: "",
        emailType: "",
        linkedinUrl: "https://linkedin.com/in/felix",
        confidence: 0.85
      },
      {
        name: "Chuck",
        title: "Vice President",
        email: "",
        emailType: "",
        confidence: 0.85
      }
    ]
  });

  assert.equal(merged.length, 4);
  assert.equal(merged[0].name, "Jane Doe");
  assert.equal(merged[0].source, "apollo+codex_public");
  assert.equal(merged[0].title, "Chief Executive Officer");
  assert.equal(merged[0].linkedinUrl, "https://linkedin.com/in/jane-public");
  assert.equal(merged[0].email, "jane@example.com");
  assert.equal(merged[0].emailSource, "codex_public");
  assert.equal(merged[1].email, "alex@apollo.example");
  assert.equal(merged[1].emailSource, "apollo");
  assert.equal(merged[2].name, "Felix Rattner");
  assert.equal(merged.some((executive) => executive.name === "Chuck"), false);
});
