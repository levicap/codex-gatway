import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

function fakeJobs() {
  return {
    stats: () => ({ queued: 0, active: 0 }),
    create: (input) => ({
      reused: false,
      job: { id: "test-job", status: "queued", input }
    }),
    list: () => [],
    get: () => null,
    database: { get: () => null }
  };
}

function testConfig(overrides = {}) {
  return {
    researchApiKey: "test-secret",
    callbackAllowedHosts: ["hooks.example.com"],
    rateLimit: { windowMs: 60000, max: 30 },
    research: { engine: "openclaw", model: "openai/gpt-5.6-terra" },
    openclaw: { agent: "lead-research" },
    jobs: { runsDir: "/tmp/research-tests" },
    ...overrides
  };
}

async function withServer(config, fn) {
  const app = createApp(config, fakeJobs());
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("requires bearer auth and accepts the typed webhook", async () => {
  await withServer(testConfig(), async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/webhooks/decision-maker-research`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyName: "Example" })
    });
    assert.equal(unauthorized.status, 401);

    const accepted = await fetch(`${baseUrl}/webhooks/decision-maker-research`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
        "idempotency-key": "lead-123"
      },
      body: JSON.stringify({ personName: "Erik Walenza", location: "Portland, United States" })
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), {
      jobId: "test-job",
      status: "queued",
      statusUrl: "/jobs/test-job",
      idempotencyReused: false
    });
  });
});

test("rejects bodies larger than 64 KB", async () => {
  await withServer(testConfig(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/decision-maker-research`, {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ companyName: "Example", jobDescription: "x".repeat(70 * 1024) })
    });
    assert.equal(response.status, 413);
  });
});

test("marks the compatibility endpoint deprecated", async () => {
  await withServer(testConfig(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/executive-enrichment`, {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ companyName: "Example" })
    });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("deprecation"), "true");
  });
});

test("rate limits by caller and bearer key", async () => {
  await withServer(testConfig({ rateLimit: { windowMs: 60000, max: 1 } }), async (baseUrl) => {
    const options = {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ companyName: "Example" })
    };
    assert.equal((await fetch(`${baseUrl}/webhooks/decision-maker-research`, options)).status, 202);
    assert.equal((await fetch(`${baseUrl}/webhooks/decision-maker-research`, options)).status, 429);
  });
});
