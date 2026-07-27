import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function stringEnv(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function numberEnv(name, fallback) {
  const raw = stringEnv(name);
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name, fallback = false) {
  const raw = stringEnv(name).toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(raw);
}

function resolveFromRoot(value, fallback) {
  const chosen = value || fallback;
  return path.isAbsolute(chosen) ? chosen : path.resolve(projectRoot, chosen);
}

export const config = {
  projectRoot,
  port: numberEnv("PORT", 3000),
  host: stringEnv("HOST", "127.0.0.1"),
  nodeEnv: stringEnv("NODE_ENV", "development"),
  researchApiKey: stringEnv("RESEARCH_API_KEY", stringEnv("WEBHOOK_AUTH_TOKEN")),
  callbackSecret: stringEnv("CALLBACK_SECRET"),
  callbackAllowedHosts: stringEnv("CALLBACK_ALLOWED_HOSTS")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
  callbackTimeoutMs: numberEnv("CALLBACK_TIMEOUT_MS", 15000),
  rateLimit: {
    windowMs: Math.max(1000, numberEnv("RATE_LIMIT_WINDOW_MS", 60000)),
    max: Math.max(1, numberEnv("RATE_LIMIT_MAX", 30))
  },

  codex: {
    bin: stringEnv("CODEX_BIN", "codex"),
    model: stringEnv("CODEX_MODEL"),
    profile: stringEnv("CODEX_PROFILE"),
    sandbox: stringEnv("CODEX_SANDBOX", "read-only"),
    liveSearch: booleanEnv("CODEX_LIVE_SEARCH", true),
    timeoutMs: numberEnv("CODEX_TIMEOUT_MS", 900000),
    workdir: resolveFromRoot(stringEnv("CODEX_WORKDIR"), "codex-workdir"),
    outputSchemaPath: path.resolve(projectRoot, "schemas", "decision-maker-research.schema.json")
  },

  research: {
    engine: stringEnv("RESEARCH_ENGINE", "openclaw").toLowerCase(),
    model: stringEnv("RESEARCH_MODEL", "openai/gpt-5.6-terra")
  },

  openclaw: {
    bin: stringEnv("OPENCLAW_BIN", "openclaw"),
    agent: stringEnv("OPENCLAW_AGENT", "lead-research"),
    thinking: stringEnv("OPENCLAW_THINKING", "medium"),
    timeoutSeconds: Math.max(1, numberEnv("OPENCLAW_TIMEOUT_SECONDS", 600)),
    killGraceMs: Math.max(1000, numberEnv("OPENCLAW_KILL_GRACE_MS", 60000)),
    maxOutputBytes: Math.max(65536, numberEnv("OPENCLAW_MAX_OUTPUT_BYTES", 10 * 1024 * 1024))
  },

  jobs: {
    runsDir: path.resolve(projectRoot, "job-runs"),
    databasePath: resolveFromRoot(stringEnv("JOBS_DATABASE_PATH"), "data/jobs.sqlite"),
    maxConcurrent: Math.max(1, numberEnv("MAX_CONCURRENT_JOBS", 2)),
    maxQueued: Math.max(1, numberEnv("MAX_QUEUED_JOBS", 100)),
    maxAttempts: 2,
    retentionMs: Math.max(60000, numberEnv("JOB_RETENTION_MS", 86400000))
  }
};
