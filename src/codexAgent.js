import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { runProcess } from "./processRunner.js";
import { buildResearchPrompt } from "./researchPrompt.js";
import { parseJsonObject, validateAndNormalizeResearch } from "./researchResult.js";

export async function readCodexResearchOutput(outputPath) {
  return parseJsonObject(await readFile(outputPath, "utf8"), "Codex final response");
}

function summarizeJsonlEvents(jsonl) {
  const tools = new Set();
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.item?.type === "web_search") tools.add("codex_hosted_search");
    } catch {
      // Ignore non-JSON diagnostics.
    }
  }
  return [...tools];
}

export async function runCodexResearch(input, jobDir, config, onProgress = () => {}) {
  await Promise.all([mkdir(jobDir, { recursive: true }), mkdir(config.codex.workdir, { recursive: true })]);
  const outputPath = path.join(jobDir, "codex-research.json");
  const eventsPath = path.join(jobDir, "codex-events.jsonl");
  const stderrPath = path.join(jobDir, "codex-stderr.log");
  const args = [];
  if (config.codex.liveSearch) args.push("--search");
  args.push("--ask-for-approval", "never");
  if (config.codex.model) args.push("--model", config.codex.model);
  if (config.codex.profile) args.push("--profile", config.codex.profile);
  args.push(
    "--cd",
    config.codex.workdir,
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    config.codex.sandbox,
    "--json",
    "--output-schema",
    config.codex.outputSchemaPath,
    "--output-last-message",
    outputPath,
    "-"
  );

  const started = Date.now();
  const result = await runProcess({
    command: config.codex.bin,
    args,
    cwd: config.projectRoot,
    input: buildResearchPrompt(input),
    timeoutMs: config.codex.timeoutMs,
    killGraceMs: config.openclaw.killGraceMs,
    maxOutputBytes: config.openclaw.maxOutputBytes,
    onStart: (child) => onProgress({
      pid: child.pid || null,
      command: config.codex.bin,
      args,
      outputPath,
      eventsPath,
      stderrPath,
      startedAt: new Date().toISOString()
    })
  });
  await Promise.all([
    writeFile(eventsPath, result.stdout, "utf8"),
    writeFile(stderrPath, result.stderr, "utf8")
  ]);

  const normalized = validateAndNormalizeResearch(await readCodexResearchOutput(outputPath));
  if (!normalized.ok) throw new Error(`Codex returned invalid research JSON: ${normalized.errors.join("; ")}`);
  const toolsUsed = summarizeJsonlEvents(result.stdout);
  return {
    status: "completed",
    model: config.codex.model || "codex-default",
    durationMs: Date.now() - started,
    toolsUsed,
    browserUsed: false,
    research: normalized.value,
    outputPath,
    eventsPath,
    stderrPath
  };
}
