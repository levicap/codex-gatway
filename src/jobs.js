import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { SqliteJobStore } from "./jobStore.js";
import { runOpenClawResearch } from "./openclawAgent.js";
import { runCodexResearch } from "./codexAgent.js";
import { postCallback } from "./callback.js";
import { buildTerminalResult } from "./researchResult.js";

export function createJobStore(config, dependencies = {}) {
  const database = dependencies.database || new SqliteJobStore(config);
  const openclawRunner = dependencies.openclawRunner || runOpenClawResearch;
  const codexRunner = dependencies.codexRunner || runCodexResearch;
  const callbackSender = dependencies.callbackSender || postCallback;
  database.recoverInterrupted();

  const queue = database.queuedIds();
  const queuedSet = new Set(queue);
  let active = 0;
  let closed = false;

  function snapshot(job) {
    if (!job) return null;
    const queueIndex = queue.indexOf(job.id);
    const queuePosition = queueIndex >= 0 ? queueIndex + 1 : null;
    return {
      id: job.id,
      status: job.status,
      statusMessage:
        job.status === "queued"
          ? `Waiting for a worker slot. Queue position: ${queuePosition || "unknown"}.`
          : job.status === "running"
            ? `${config.research.engine === "codex" ? "Codex" : "OpenClaw"} decision-maker research is running.`
            : null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      queuePosition,
      input: job.input,
      result: job.result,
      error: job.error,
      jobDir: job.jobDir,
      worker: job.worker,
      openclawLogUrl: job.jobDir ? `/jobs/${job.id}/research-log` : null,
      callback: job.callback
    };
  }

  async function deliverAndRecordCallback(job, payload) {
    let callback = { status: "skipped_no_callback_url" };
    if (job.input.callbackUrl) {
      try {
        callback = await callbackSender(job.input.callbackUrl, payload, config, (delivery) => {
          database.addCallbackDelivery(job.id, delivery);
        });
      } catch (error) {
        callback = { status: "failed", error: error.message || "Callback delivery failed." };
      }
    }

    try {
      database.setCallback(job.id, callback);
    } catch {
      // Callback persistence must never rewrite the already-terminal research status.
    }
  }

  async function runJob(id) {
    const job = database.get(id);
    if (!job || job.status !== "queued") return;
    const jobDir = path.join(config.jobs.runsDir, id);
    const engine = config.research.engine === "codex" ? "codex" : "openclaw";
    const attemptNo = database.markRunning(id, engine, jobDir);
    await mkdir(jobDir, { recursive: true });

    try {
      const runner = engine === "codex" ? codexRunner : openclawRunner;
      const run = await runner(job.input, jobDir, config, (progress) => {
        database.updateWorker(id, {
          engine,
          ...progress
        });
      });
      const payload = buildTerminalResult({ jobId: id, input: job.input, research: run.research, run });
      database.finishAttempt(id, attemptNo, "completed", {
        durationMs: run.durationMs,
        model: run.model,
        toolsUsed: run.toolsUsed,
        repaired: Boolean(run.repaired)
      });
      database.markTerminal(id, "completed", payload);
      await deliverAndRecordCallback(job, payload);
    } catch (error) {
      const payload = {
        jobId: id,
        status: "failed",
        error: error.message,
        metadata: job.input.metadata
      };
      database.finishAttempt(id, attemptNo, "failed", null, error.message);
      database.markTerminal(id, "failed", payload, error.message);
      await deliverAndRecordCallback(job, payload);
    }
  }

  function drain() {
    if (closed) return;
    while (active < config.jobs.maxConcurrent && queue.length) {
      const id = queue.shift();
      queuedSet.delete(id);
      active += 1;
      runJob(id)
        .catch((error) => {
          const job = database.get(id);
          if (job && !["completed", "failed"].includes(job.status)) {
            const payload = { jobId: id, status: "failed", error: error.message, metadata: job.input.metadata };
            database.markTerminal(id, "failed", payload, error.message);
          }
        })
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function enqueue(id) {
    if (!queuedSet.has(id)) {
      queue.push(id);
      queuedSet.add(id);
    }
    queueMicrotask(drain);
  }

  function create(input, idempotencyKey = "") {
    const created = database.create(input, idempotencyKey);
    if (!created.reused && created.job.status === "queued") enqueue(created.job.id);
    return { job: snapshot(created.job), reused: created.reused };
  }

  function get(id) {
    return snapshot(database.get(id));
  }

  function list() {
    return database.list().map(snapshot);
  }

  function stats() {
    return {
      ...database.stats(),
      active,
      inMemoryQueued: queue.length,
      maxConcurrent: config.jobs.maxConcurrent,
      maxQueued: config.jobs.maxQueued
    };
  }

  async function purgeOldJobs() {
    const purged = database.purgeExpired(config.jobs.retentionMs);
    const runsRoot = path.resolve(config.jobs.runsDir);
    await Promise.all(
      purged.jobs.map(({ id, jobDir }) => {
        const target = path.resolve(jobDir || path.join(runsRoot, id));
        if (!target.startsWith(`${runsRoot}${path.sep}`)) return Promise.resolve();
        return rm(target, { recursive: true, force: true });
      })
    );
    return purged.count;
  }

  function close() {
    closed = true;
    database.close();
  }

  queueMicrotask(drain);
  return { create, get, list, stats, purgeOldJobs, close, database };
}
