import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTerminalResult,
  canonicalizeLinkedInUrl,
  validateAndNormalizeResearch
} from "../src/researchResult.js";

function validResearch(overrides = {}) {
  return {
    resolvedCompanyName: "Example Inc.",
    website: "https://example.com/about",
    domain: "www.example.com",
    confidence: 0.96,
    sourceUrls: ["https://example.com/about"],
    decisionMakers: [
      {
        name: "Person Name",
        title: "Chief Executive Officer",
        company: "Example Inc.",
        linkedinUrl: "https://linkedin.com/in/person-slug/?trk=search",
        confidence: 0.94,
        relevanceReason: "Founder and current CEO",
        sourceUrls: ["https://example.com/team"],
        linkedinEvidenceUrls: ["https://www.linkedin.com/in/person-slug?trk=search"]
      }
    ],
    warnings: [],
    ...overrides
  };
}

test("canonicalizes only individual LinkedIn profile URLs", () => {
  assert.equal(
    canonicalizeLinkedInUrl("linkedin.com/in/person-slug/?trk=search#about"),
    "https://www.linkedin.com/in/person-slug"
  );
  assert.equal(canonicalizeLinkedInUrl("https://linkedin.com/company/example"), "");
  assert.equal(canonicalizeLinkedInUrl("https://example.com/in/person"), "");
  assert.equal(canonicalizeLinkedInUrl("https://linkedin.com/in/person%2Fother"), "");
});

test("normalizes a verified result and computes partial coverage", () => {
  const normalized = validateAndNormalizeResearch(validResearch());
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.website, "https://example.com");
  assert.equal(normalized.value.domain, "example.com");
  assert.equal(normalized.value.decisionMakers[0].linkedinUrl, "https://www.linkedin.com/in/person-slug");

  const result = buildTerminalResult({
    jobId: "job-id",
    input: { companyWebsite: "https://input.example/about", metadata: { source: "test" } },
    research: normalized.value,
    run: {
      model: "openai/gpt-5.6-terra",
      toolsUsed: ["codex_hosted_search"],
      browserUsed: false,
      durationMs: 1000
    }
  });
  assert.deepEqual(result.coverage, { requested: 3, returned: 1, status: "partial" });
  assert.equal(result.target.website, "https://input.example");
  assert.equal(result.target.domain, "input.example");
});

test("accepts an ambiguous target as successful zero coverage", () => {
  const normalized = validateAndNormalizeResearch(
    validResearch({
      resolvedCompanyName: "",
      website: "",
      domain: "",
      confidence: 0,
      sourceUrls: [],
      decisionMakers: [],
      warnings: ["ambiguous_target"]
    })
  );
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.decisionMakers.length, 0);
});

test("rejects profiles without non-LinkedIn relationship evidence", () => {
  const input = validResearch();
  input.decisionMakers[0].sourceUrls = ["https://www.linkedin.com/in/person-slug"];
  const normalized = validateAndNormalizeResearch(input);
  assert.equal(normalized.ok, false);
  assert.match(normalized.errors.join(" "), /non-LinkedIn/);
});

test("rejects LinkedIn evidence for a different profile", () => {
  const input = validResearch();
  input.decisionMakers[0].linkedinEvidenceUrls = ["https://linkedin.com/in/another-person"];
  const normalized = validateAndNormalizeResearch(input);
  assert.equal(normalized.ok, false);
  assert.match(normalized.errors.join(" "), /does not tie/);
});

test("rejects whitespace-only decision-maker identity fields", () => {
  const input = validResearch();
  input.decisionMakers[0].name = "   ";
  const normalized = validateAndNormalizeResearch(input);
  assert.equal(normalized.ok, false);
  assert.match(normalized.errors.join(" "), /name must not be blank/);
});

test("rejects people for an unresolved or ambiguous target", () => {
  const unresolved = validateAndNormalizeResearch(validResearch({ resolvedCompanyName: "" }));
  assert.equal(unresolved.ok, false);
  assert.match(unresolved.errors.join(" "), /required when decisionMakers/);

  const ambiguous = validateAndNormalizeResearch(validResearch({ warnings: ["ambiguous_target"] }));
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.errors.join(" "), /ambiguous_target/);
});
