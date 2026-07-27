import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanDomain,
  domainFromWebsite,
  normalizeWebsite,
  pickCompanyWebsite
} from "../src/company.js";
import { validateIdempotencyKey, validateResearchRequest } from "../src/validation.js";

test("normalizes websites and domains", () => {
  assert.equal(normalizeWebsite("openai.com/about"), "https://openai.com");
  assert.equal(normalizeWebsite("https://www.openai.com/about"), "https://www.openai.com");
  assert.equal(domainFromWebsite("https://www.openai.com/about"), "openai.com");
  assert.equal(cleanDomain("https://www.openai.com/about"), "openai.com");
});

test("prefers input website over researched website", () => {
  assert.equal(
    pickCompanyWebsite("example.com", "https://openai.com", "openai.com"),
    "https://example.com"
  );
  assert.equal(pickCompanyWebsite("", "", "openai.com"), "https://openai.com");
});

test("accepts sparse company, website, and person inputs", () => {
  assert.equal(validateResearchRequest({ companyName: "OpenAI" }).ok, true);
  assert.equal(validateResearchRequest({ companyWebsite: "openai.com" }).ok, true);
  const person = validateResearchRequest({ personName: "Erik Walenza", location: "Portland, United States" });
  assert.equal(person.ok, true);
  assert.equal(person.value.personName, "Erik Walenza");
});

test("maps the deprecated client name alias to personName", () => {
  const result = validateResearchRequest({ clientName: "Erik Walenza", companyName: "Example" });
  assert.equal(result.ok, true);
  assert.equal(result.value.personName, "Erik Walenza");
});

test("requires an identity anchor and limits job description length", () => {
  const missing = validateResearchRequest({ jobTitle: "AI process automation" });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(" "), /At least one/);

  const tooLong = validateResearchRequest({
    companyName: "Example",
    jobDescription: "x".repeat(20001)
  });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.errors.join(" "), /20,000/);
});

test("requires callback HTTPS and an allowlisted host", () => {
  const http = validateResearchRequest(
    { companyName: "Example", callbackUrl: "http://hooks.example.com/result" },
    { callbackAllowedHosts: ["hooks.example.com"] }
  );
  assert.equal(http.ok, false);
  assert.match(http.errors.join(" "), /HTTPS/);

  const allowed = validateResearchRequest(
    { companyName: "Example", callbackUrl: "https://hooks.example.com/result" },
    { callbackAllowedHosts: ["hooks.example.com"] }
  );
  assert.equal(allowed.ok, true);
});

test("rejects callbacks when the signing secret is not configured", () => {
  const result = validateResearchRequest(
    { companyName: "Example", callbackUrl: "https://hooks.example.com/result" },
    {
      callbackAllowedHosts: ["hooks.example.com"],
      callbackSecretConfigured: false
    }
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /CALLBACK_SECRET/);
});

test("validates stable idempotency keys", () => {
  assert.deepEqual(validateIdempotencyKey("lead:123-v1"), { ok: true, value: "lead:123-v1" });
  assert.equal(validateIdempotencyKey("bad key").ok, false);
});
