import express from "express";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as defaultConfig } from "./config.js";
import { validateIdempotencyKey, validateResearchRequest } from "./validation.js";
import { createJobStore } from "./jobs.js";
import { IdempotencyConflictError, QueueFullError } from "./jobStore.js";
import { bearerTokenFromRequest, createRateLimiter, timingSafeTokenEqual } from "./security.js";

function requireResearchAuth(config) {
  return (req, res, next) => {
    if (!config.researchApiKey) {
      res.status(503).json({ error: "RESEARCH_API_KEY is not configured." });
      return;
    }
    if (!timingSafeTokenEqual(bearerTokenFromRequest(req), config.researchApiKey)) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    next();
  };
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    statusMessage: job.statusMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    queuePosition: job.queuePosition,
    input: job.input,
    result: job.result,
    error: job.error,
    openclawLogUrl: job.openclawLogUrl,
    callback: job.callback
  };
}

export function createApp(config = defaultConfig, jobs = createJobStore(config)) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "64kb", type: ["application/json", "application/*+json"] }));

  const protectedRoute = [
    createRateLimiter(config.rateLimit),
    requireResearchAuth(config)
  ];

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "openclaw-decision-maker-webhook",
      authConfigured: Boolean(config.researchApiKey),
      callbackHostsConfigured: config.callbackAllowedHosts.length,
      research: {
        engine: config.research.engine,
        model: config.research.model,
        agent: config.openclaw.agent
      },
      queue: jobs.stats()
    });
  });

  function submitResearch(req, res) {
    const validation = validateResearchRequest(req.body, {
      callbackAllowedHosts: config.callbackAllowedHosts,
      callbackSecretConfigured: Boolean(config.callbackSecret)
    });
    if (!validation.ok) {
      res.status(400).json({ errors: validation.errors });
      return;
    }

    const idempotency = validateIdempotencyKey(req.get("idempotency-key"));
    if (!idempotency.ok) {
      res.status(400).json({ error: idempotency.error });
      return;
    }

    try {
      const created = jobs.create(validation.value, idempotency.value);
      const job = created.job;
      res.status(202).json({
        jobId: job.id,
        status: job.status,
        statusUrl: `/jobs/${job.id}`,
        idempotencyReused: created.reused
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof QueueFullError) {
        res.status(429).json({ error: error.message });
        return;
      }
      throw error;
    }
  }

  app.post("/webhooks/decision-maker-research", ...protectedRoute, submitResearch);
  app.post("/webhooks/executive-enrichment", ...protectedRoute, (req, res) => {
    res.set("Deprecation", "true");
    res.set("Link", '</webhooks/decision-maker-research>; rel="successor-version"');
    submitResearch(req, res);
  });

  app.get("/jobs", ...protectedRoute, (_req, res) => {
    res.json({ stats: jobs.stats(), jobs: jobs.list().map(publicJob) });
  });

  app.get("/jobs/:jobId", ...protectedRoute, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.json(publicJob(job));
  });

  app.get("/jobs/:jobId/research-log", ...protectedRoute, async (req, res, next) => {
    try {
      const job = jobs.database.get(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: "Job not found." });
        return;
      }
      const jobDir = job.jobDir || path.join(config.jobs.runsDir, job.id);
      const paths = config.research.engine === "codex"
        ? [
            ["codex-events.jsonl", path.join(jobDir, "codex-events.jsonl")],
            ["codex-stderr.log", path.join(jobDir, "codex-stderr.log")]
          ]
        : [
            ["openclaw-response.json", path.join(jobDir, "openclaw-response.json")],
            ["openclaw-stderr.log", path.join(jobDir, "openclaw-stderr.log")],
            ["openclaw-repair-response.json", path.join(jobDir, "openclaw-repair-response.json")],
            ["openclaw-repair-stderr.log", path.join(jobDir, "openclaw-repair-stderr.log")]
          ];
      const sections = await Promise.all(
        paths.map(async ([label, filename]) => [label, await readFile(filename, "utf8").catch(() => "")])
      );
      res.type("text/plain").send(
        [
          `jobId: ${job.id}`,
          `status: ${job.status}`,
          `engine: ${config.research.engine}`,
          "",
          ...sections.flatMap(([label, content]) => [`--- ${label} ---`, content || "(no output)", ""])
        ].join("\n")
      );
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body must be valid JSON." });
      return;
    }
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "Request body must be at most 64 KB." });
      return;
    }
    console.error("request_failed", { name: error?.name, message: error?.message });
    res.status(500).json({ error: "Internal server error." });
  });

  return app;
}

export async function startServer(config = defaultConfig) {
  await Promise.all([
    mkdir(config.jobs.runsDir, { recursive: true }),
    mkdir(config.codex.workdir, { recursive: true })
  ]);
  const jobs = createJobStore(config);
  const app = createApp(config, jobs);
  const cleanupInterval = setInterval(() => {
    jobs.purgeOldJobs().catch((error) => {
      console.error("retention_cleanup_failed", { name: error?.name, message: error?.message });
    });
  }, 60 * 60 * 1000);
  cleanupInterval.unref();
  const server = app.listen(config.port, config.host, () => {
    console.log(`Decision-maker webhook listening on http://${config.host}:${config.port}`);
  });
  return { app, jobs, server };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await startServer();
