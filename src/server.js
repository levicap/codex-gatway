import express from "express";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { validateEnrichmentRequest } from "./validation.js";
import { createJobStore } from "./jobs.js";

const app = express();
const jobs = createJobStore(config);

app.use(express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));
app.use(express.text({ limit: "1mb", type: ["text/plain", "text/*"] }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

function requestDebug(req) {
  const body = req.body;
  const bodyType = Array.isArray(body) ? "array" : typeof body;
  const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
  const preview = typeof body === "string" ? body : JSON.stringify(body);

  return {
    contentType: req.get("content-type") || "",
    bodyType,
    keys,
    preview: preview ? preview.slice(0, 300) : ""
  };
}

function requireWebhookAuth(req, res, next) {
  if (!config.webhookAuthToken) {
    next();
    return;
  }

  const expected = `Bearer ${config.webhookAuthToken}`;
  const provided = req.get("authorization") || "";
  const tokenHeader = req.get("x-webhook-token") || "";

  if (provided === expected || tokenHeader === config.webhookAuthToken) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized." });
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "codex-executive-webhook",
    codex: {
      bin: config.codex.bin,
      sandbox: config.codex.sandbox,
      liveSearch: config.codex.liveSearch,
      apolloMcpEnabled: config.codex.enableApolloMcp,
      visibleTerminal: config.codex.visibleTerminal
    },
    apolloConfigured: Boolean(config.apollo.apiKey)
  });
});

app.post("/webhooks/executive-enrichment", requireWebhookAuth, (req, res) => {
  const validation = validateEnrichmentRequest(req.body);
  if (!validation.ok) {
    res.status(400).json({ errors: validation.errors, debug: requestDebug(req) });
    return;
  }

  const job = jobs.create(validation.value);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    statusUrl: `/jobs/${job.id}`
  });
});

app.get("/jobs/:jobId", requireWebhookAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  res.json(job);
});

app.get("/jobs/:jobId/codex-log", requireWebhookAuth, async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  const eventsPath = job.codex?.eventsPath || path.join(config.jobs.runsDir, job.id, "codex-events.jsonl");
  const stderrPath = job.codex?.stderrPath || path.join(config.jobs.runsDir, job.id, "codex-stderr.log");
  const [events, stderr] = await Promise.all([
    readFile(eventsPath, "utf8").catch(() => ""),
    readFile(stderrPath, "utf8").catch(() => "")
  ]);

  res.type("text/plain").send(
    [
      `jobId: ${job.id}`,
      `status: ${job.status}`,
      `codexPid: ${job.codex?.pid || ""}`,
      `eventsPath: ${eventsPath}`,
      `stderrPath: ${stderrPath}`,
      "",
      "--- codex jsonl events ---",
      events || "(no Codex stdout events captured yet)",
      "",
      "--- codex stderr ---",
      stderr || "(no Codex stderr captured yet)"
    ].join("\n")
  );
});

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Request body must be valid JSON." });
    return;
  }

  console.error(error);
  res.status(500).json({ error: "Internal server error." });
});

await Promise.all([
  mkdir(config.jobs.runsDir, { recursive: true }),
  mkdir(config.codex.workdir, { recursive: true })
]);

setInterval(() => jobs.purgeOldJobs(), 60 * 60 * 1000).unref();

app.listen(config.port, () => {
  console.log(`Codex executive webhook listening on http://localhost:${config.port}`);
});
