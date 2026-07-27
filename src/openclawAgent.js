import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { runProcess } from "./processRunner.js";
import { buildResearchPrompt, buildSchemaRepairPrompt } from "./researchPrompt.js";
import { parseJsonObject, validateAndNormalizeResearch } from "./researchResult.js";

function preferredAssistantText(response) {
  const finalAssistantText = [
    response?.result?.meta?.finalAssistantVisibleText,
    response?.result?.meta?.finalAssistantRawText,
    response?.meta?.finalAssistantVisibleText,
    response?.meta?.finalAssistantRawText
  ].find((item) => typeof item === "string" && item.trim());
  if (finalAssistantText) return finalAssistantText.trim();

  const payloadGroups = [
    response?.result?.payloads,
    response?.payloads,
    response?.data?.result?.payloads,
    response?.data?.payloads
  ];
  for (const payloads of payloadGroups) {
    if (!Array.isArray(payloads)) continue;
    const text = payloads.map((item) => item?.text).filter((item) => typeof item === "string").join("\n").trim();
    if (text) return text;
  }

  const direct = [
    response?.result?.text,
    response?.result?.response,
    response?.response,
    response?.text,
    response?.message?.content,
    response?.data?.text
  ];
  return direct.find((item) => typeof item === "string" && item.trim())?.trim() || "";
}

export function extractOpenClawAssistantText(raw) {
  const response = parseJsonObject(raw, "OpenClaw CLI response");
  if (response?.status && !["ok", "completed", "success"].includes(String(response.status).toLowerCase())) {
    throw new Error(`OpenClaw reported status ${response.status}: ${response.error || response.message || "agent run failed"}`);
  }
  const text = preferredAssistantText(response);
  if (!text) throw new Error("OpenClaw JSON response did not contain assistant text.");
  return { text, response };
}

function walkAudit(value, names) {
  if (Array.isArray(value)) {
    for (const item of value) walkAudit(item, names);
    return;
  }
  if (!value || typeof value !== "object") return;

  const type = String(value.type || value.event || value.action || "").toLowerCase();
  if (type.includes("tool")) {
    for (const key of ["toolName", "tool_name", "tool", "name"]) {
      if (typeof value[key] === "string" && value[key]) names.add(value[key]);
    }
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") walkAudit(child, names);
  }
}

function normalizeToolName(name) {
  const lower = String(name).toLowerCase();
  if (lower.includes("web_search") || lower.includes("hosted_search")) return "codex_hosted_search";
  if (lower.includes("web_fetch") || lower === "fetch") return "web_fetch";
  if (lower.includes("browser")) return "browser";
  return "";
}

export function toolsFromAudit(raw) {
  const parsed = parseJsonObject(raw, "OpenClaw audit response");
  const names = new Set();
  walkAudit(parsed, names);
  return [...new Set([...names].map(normalizeToolName).filter(Boolean))].sort();
}

async function queryAudit(config, sessionKey, startedAt, runProcessFn) {
  const canonicalSessionKey = sessionKey.startsWith("agent:")
    ? sessionKey
    : `agent:${config.openclaw.agent}:${sessionKey}`;
  const args = ["audit", "--session", canonicalSessionKey, "--after", startedAt, "--json"];
  const result = await runProcessFn({
    command: config.openclaw.bin,
    args,
    cwd: config.projectRoot,
    timeoutMs: 30000,
    killGraceMs: 5000,
    maxOutputBytes: config.openclaw.maxOutputBytes
  });
  return toolsFromAudit(result.stdout);
}

async function runTurn({ config, sessionKey, messageFile, onStart, runProcessFn, timeoutMs }) {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = [
    "agent",
    "--agent",
    config.openclaw.agent,
    "--session-key",
    sessionKey,
    "--message-file",
    messageFile,
    "--thinking",
    config.openclaw.thinking,
    "--timeout",
    String(timeoutSeconds),
    "--json"
  ];
  const result = await runProcessFn({
    command: config.openclaw.bin,
    args,
    cwd: config.projectRoot,
    timeoutMs,
    killGraceMs: config.openclaw.killGraceMs,
    maxOutputBytes: config.openclaw.maxOutputBytes,
    onStart: (child) => onStart(child, args)
  });
  return { ...result, args };
}

export async function runOpenClawResearch(
  input,
  jobDir,
  config,
  onProgress = () => {},
  dependencies = {}
) {
  const runProcessFn = dependencies.runProcessFn || runProcess;
  await mkdir(jobDir, { recursive: true });
  const sessionKey = `job-${path.basename(jobDir)}`;
  const promptPath = path.join(jobDir, "openclaw-prompt.txt");
  const stdoutPath = path.join(jobDir, "openclaw-response.json");
  const stderrPath = path.join(jobDir, "openclaw-stderr.log");
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const deadline = started + config.openclaw.timeoutSeconds * 1000;

  await writeFile(promptPath, buildResearchPrompt(input), "utf8");
  let turn = await runTurn({
    config,
    sessionKey,
    messageFile: promptPath,
    runProcessFn,
    timeoutMs: Math.max(1, deadline - Date.now()),
    onStart: (child, args) => {
      onProgress({
        pid: child.pid || null,
        command: config.openclaw.bin,
        args,
        sessionKey,
        promptPath,
        stdoutPath,
        stderrPath,
        startedAt
      });
    }
  });
  await Promise.all([
    writeFile(stdoutPath, turn.stdout, "utf8"),
    writeFile(stderrPath, turn.stderr, "utf8")
  ]);

  let assistant;
  let normalized;
  let validationErrors;
  try {
    assistant = extractOpenClawAssistantText(turn.stdout);
    const parsed = parseJsonObject(assistant.text);
    normalized = validateAndNormalizeResearch(parsed);
    validationErrors = normalized.ok ? [] : normalized.errors;
  } catch (error) {
    validationErrors = [error.message];
  }

  let repaired = false;
  if (validationErrors.length) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("OpenClaw exhausted the 10-minute job deadline before schema repair.");
    }
    repaired = true;
    const repairPath = path.join(jobDir, "openclaw-repair-prompt.txt");
    const repairStdoutPath = path.join(jobDir, "openclaw-repair-response.json");
    const repairStderrPath = path.join(jobDir, "openclaw-repair-stderr.log");
    await writeFile(repairPath, buildSchemaRepairPrompt(validationErrors), "utf8");
    turn = await runTurn({
      config,
      sessionKey,
      messageFile: repairPath,
      runProcessFn,
      timeoutMs: remainingMs,
      onStart: (child, args) => {
        onProgress({
          pid: child.pid || null,
          command: config.openclaw.bin,
          args,
          sessionKey,
          repair: true,
          promptPath: repairPath,
          stdoutPath: repairStdoutPath,
          stderrPath: repairStderrPath,
          startedAt
        });
      }
    });
    await Promise.all([
      writeFile(repairStdoutPath, turn.stdout, "utf8"),
      writeFile(repairStderrPath, turn.stderr, "utf8")
    ]);
    assistant = extractOpenClawAssistantText(turn.stdout);
    normalized = validateAndNormalizeResearch(parseJsonObject(assistant.text));
    if (!normalized.ok) {
      throw new Error(`OpenClaw returned invalid research JSON after one repair: ${normalized.errors.join("; ")}`);
    }
  }

  let toolsUsed = [];
  let auditWarning = "";
  try {
    toolsUsed = await queryAudit(config, sessionKey, startedAt, runProcessFn);
  } catch (error) {
    auditWarning = "audit_unavailable";
  }

  const research = normalized.value;
  if (auditWarning) research.warnings = [...new Set([...research.warnings, auditWarning])];
  return {
    status: "completed",
    model: config.research.model,
    durationMs: Date.now() - started,
    toolsUsed,
    browserUsed: toolsUsed.includes("browser"),
    research,
    sessionKey,
    repaired,
    promptPath,
    stdoutPath,
    stderrPath
  };
}
