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
  nodeEnv: stringEnv("NODE_ENV", "development"),
  webhookAuthToken: stringEnv("WEBHOOK_AUTH_TOKEN"),
  callbackSecret: stringEnv("CALLBACK_SECRET"),

  apollo: {
    apiKey: stringEnv("APOLLO_API_KEY"),
    baseUrl: stringEnv("APOLLO_BASE_URL", "https://api.apollo.io/api/v1").replace(/\/+$/, ""),
    peopleSearchPath: stringEnv("APOLLO_PEOPLE_SEARCH_PATH", "/mixed_people/api_search"),
    peopleEnrichmentPath: stringEnv("APOLLO_PEOPLE_ENRICHMENT_PATH", "/people/match"),
    includeEmails: booleanEnv("APOLLO_INCLUDE_EMAILS", false),
    enrichPeople: booleanEnv("APOLLO_ENRICH_PEOPLE", true),
    enrichLimit: Math.max(0, numberEnv("APOLLO_ENRICH_LIMIT", 10)),
    timeoutMs: numberEnv("APOLLO_TIMEOUT_MS", 30000)
  },

  codex: {
    bin: stringEnv("CODEX_BIN", "codex"),
    model: stringEnv("CODEX_MODEL"),
    profile: stringEnv("CODEX_PROFILE"),
    sandbox: stringEnv("CODEX_SANDBOX", "read-only"),
    liveSearch: booleanEnv("CODEX_LIVE_SEARCH", true),
    visibleTerminal: booleanEnv("CODEX_VISIBLE_TERMINAL", false),
    visibleTerminalHold: booleanEnv("CODEX_VISIBLE_TERMINAL_HOLD", true),
    enableApolloMcp: booleanEnv("CODEX_ENABLE_APOLLO_MCP", true),
    apolloMcpRequired: booleanEnv("CODEX_APOLLO_MCP_REQUIRED", true),
    timeoutMs: numberEnv("CODEX_TIMEOUT_MS", 900000),
    workdir: resolveFromRoot(stringEnv("CODEX_WORKDIR"), "codex-workdir"),
    outputSchemaPath: path.resolve(projectRoot, "schemas", "company-research.schema.json")
  },

  jobs: {
    runsDir: path.resolve(projectRoot, "job-runs"),
    maxConcurrent: Math.max(1, numberEnv("MAX_CONCURRENT_JOBS", 2)),
    retentionMs: Math.max(60000, numberEnv("JOB_RETENTION_MS", 86400000))
  }
};
