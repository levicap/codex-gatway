import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { IdempotencyConflictError, SqliteJobStore } from "../src/jobStore.js";
import { createJobStore } from "../src/jobs.js";

function testConfig(databasePath) {
  return {
    jobs: {
      databasePath,
      maxQueued: 100,
      maxAttempts: 2
    }
  };
}

test("persists jobs and enforces idempotency request identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "research-job-store-"));
  const databasePath = path.join(dir, "jobs.sqlite");
  const store = new SqliteJobStore(testConfig(databasePath));
  try {
    const first = store.create({ companyName: "Example" }, "stable-key");
    const replay = store.create({ companyName: "Example" }, "stable-key");
    assert.equal(replay.reused, true);
    assert.equal(replay.job.id, first.job.id);
    assert.throws(
      () => store.create({ companyName: "Different" }, "stable-key"),
      IdempotencyConflictError
    );

    store.close();
    const reopened = new SqliteJobStore(testConfig(databasePath));
    assert.equal(reopened.get(first.job.id).input.companyName, "Example");
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("requeues one interrupted attempt and fails after the second", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "research-job-recovery-"));
  const databasePath = path.join(dir, "jobs.sqlite");
  const config = testConfig(databasePath);
  try {
    let store = new SqliteJobStore(config);
    const created = store.create({ personName: "Person" }).job;
    assert.equal(store.markRunning(created.id, "openclaw", path.join(dir, created.id)), 1);
    store.close();

    store = new SqliteJobStore(config);
    assert.equal(store.recoverInterrupted(), 1);
    assert.equal(store.get(created.id).status, "queued");
    assert.equal(store.markRunning(created.id, "openclaw", path.join(dir, created.id)), 2);
    store.close();

    store = new SqliteJobStore(config);
    assert.equal(store.recoverInterrupted(), 1);
    assert.equal(store.get(created.id).status, "failed");
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("callback failures do not change completed research status", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "research-callback-status-"));
  const config = {
    research: { engine: "openclaw" },
    jobs: {
      databasePath: path.join(dir, "jobs.sqlite"),
      runsDir: path.join(dir, "runs"),
      maxQueued: 100,
      maxConcurrent: 1,
      maxAttempts: 2,
      retentionMs: 86400000
    }
  };
  const jobs = createJobStore(config, {
    openclawRunner: async () => ({
      research: {
        resolvedCompanyName: "Example Inc.",
        website: "https://example.com",
        domain: "example.com",
        confidence: 1,
        sourceUrls: ["https://example.com/about"],
        decisionMakers: [],
        warnings: []
      },
      model: "openai/gpt-5.6-terra",
      toolsUsed: ["codex_hosted_search"],
      browserUsed: false,
      durationMs: 1
    }),
    callbackSender: async () => {
      throw new Error("callback transport unavailable");
    }
  });

  try {
    const created = jobs.create({
      companyName: "Example Inc.",
      callbackUrl: "https://hooks.example.com/result",
      metadata: {}
    }).job;
    let current = jobs.get(created.id);
    for (let index = 0; index < 100 && !current.callback; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = jobs.get(created.id);
    }

    assert.equal(current.status, "completed");
    assert.equal(current.result.status, "completed");
    assert.equal(current.callback.status, "failed");
    assert.match(current.callback.error, /transport unavailable/);
  } finally {
    jobs.close();
    await rm(dir, { recursive: true, force: true });
  }
});
