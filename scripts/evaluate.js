import { readFile } from "node:fs/promises";

const baseUrl = (process.env.RESEARCH_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const apiKey = process.env.RESEARCH_API_KEY || "";
const pollIntervalMs = Number(process.env.EVALUATION_POLL_MS || 2000);
const timeoutMs = Number(process.env.EVALUATION_TIMEOUT_MS || 12 * 60 * 1000);

if (!apiKey) {
  console.error("RESEARCH_API_KEY is required.");
  process.exitCode = 2;
} else {
  await main();
}

async function api(requestPath, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...options,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForJob(jobId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await api(`/jobs/${jobId}`);
    if (job.status === "completed" || job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for ${jobId}.`);
}

async function main() {
  const fixtures = JSON.parse(
    await readFile(new URL("../evaluation/live-fixtures.json", import.meta.url), "utf8")
  );
  let truePositives = 0;
  let falsePositives = 0;
  let expectedTotal = 0;
  let returnedTotal = 0;
  let scored = 0;

  for (const fixture of fixtures) {
    const submitted = await api("/webhooks/decision-maker-research", {
      method: "POST",
      headers: { "idempotency-key": `evaluation-${fixture.id}-v1` },
      body: JSON.stringify(fixture.input)
    });
    const job = await waitForJob(submitted.jobId);
    const returned = new Set((job.result?.decisionMakers || []).map((person) => person.linkedinUrl));
    const expected = new Set(fixture.expectedLinkedInUrls || []);
    returnedTotal += returned.size;

    if (fixture.verified === true) {
      scored += 1;
      expectedTotal += expected.size;
      for (const url of returned) {
        if (expected.has(url)) truePositives += 1;
        else falsePositives += 1;
      }
    }

    console.log(JSON.stringify({
      fixture: fixture.id,
      status: job.status,
      coverage: job.result?.coverage || null,
      returned: [...returned],
      scored: fixture.verified === true
    }));
  }

  const precision = truePositives + falsePositives
    ? truePositives / (truePositives + falsePositives)
    : 0;
  const coverage = expectedTotal ? truePositives / expectedTotal : 0;
  const gatePassed = scored >= 20 && precision >= 0.95;
  console.log(JSON.stringify({
    scoredFixtures: scored,
    truePositives,
    falsePositives,
    precision,
    coverage,
    returnedTotal,
    gatePassed
  }));
  if (!gatePassed) process.exitCode = 1;
}
