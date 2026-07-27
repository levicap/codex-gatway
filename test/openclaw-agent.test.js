import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  extractOpenClawAssistantText,
  runOpenClawResearch,
  toolsFromAudit
} from "../src/openclawAgent.js";
import { runProcess } from "../src/processRunner.js";

test("extracts assistant text from OpenClaw JSON payloads", () => {
  const raw = JSON.stringify({
    status: "ok",
    result: {
      payloads: [{ text: '{"decisionMakers":[]}' }]
    }
  });
  assert.equal(extractOpenClawAssistantText(raw).text, '{"decisionMakers":[]}');
});

test("prefers final assistant text over extra CLI progress payloads", () => {
  const raw = JSON.stringify({
    status: "ok",
    result: {
      payloads: [
        { text: '{"decisionMakers":[]}' },
        { text: "tool progress warning" }
      ],
      meta: {
        finalAssistantVisibleText: '{"decisionMakers":[]}'
      }
    }
  });
  assert.equal(extractOpenClawAssistantText(raw).text, '{"decisionMakers":[]}');
});

test("derives tools from audit records", () => {
  const raw = JSON.stringify({
    records: [
      { type: "tool_action", toolName: "web_search" },
      { type: "tool_action", toolName: "web_fetch" },
      { type: "tool_action", toolName: "browser.open" }
    ]
  });
  assert.deepEqual(toolsFromAudit(raw), ["browser", "codex_hosted_search", "web_fetch"]);
});

function config() {
  return {
    projectRoot: process.cwd(),
    research: { model: "openai/gpt-5.6-terra" },
    openclaw: {
      bin: "openclaw",
      agent: "lead-research",
      thinking: "medium",
      timeoutSeconds: 600,
      killGraceMs: 1000,
      maxOutputBytes: 1024 * 1024
    }
  };
}

function validAgentText(overrides = {}) {
  return JSON.stringify({
    resolvedCompanyName: "Example",
    website: "https://example.com",
    domain: "example.com",
    confidence: 0.9,
    sourceUrls: ["https://example.com/about"],
    decisionMakers: [],
    warnings: [],
    ...overrides
  });
}

function cliResponse(text) {
  return JSON.stringify({ status: "ok", result: { payloads: [{ text }] } });
}

test("repairs malformed output once in the same session and uses audit tool metadata", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-repair-"));
  const calls = [];
  const responses = [
    { stdout: cliResponse('{"bad":true}'), stderr: "", code: 0 },
    { stdout: cliResponse(validAgentText()), stderr: "", code: 0 },
    {
      stdout: JSON.stringify({
        records: [
          { type: "tool_action", toolName: "web_search" },
          { type: "tool_action", toolName: "browser.open" }
        ]
      }),
      stderr: "",
      code: 0
    }
  ];
  try {
    const run = await runOpenClawResearch(
      { companyName: "Example", metadata: {} },
      dir,
      config(),
      () => {},
      {
        runProcessFn: async (options) => {
          calls.push(options.args);
          return responses.shift();
        }
      }
    );
    assert.equal(run.repaired, true);
    assert.deepEqual(run.toolsUsed, ["browser", "codex_hosted_search"]);
    assert.equal(run.browserUsed, true);
    assert.equal(calls[0][0], "agent");
    assert.equal(calls[1][0], "agent");
    assert.equal(calls[2][0], "audit");
    assert.equal(calls[0][calls[0].indexOf("--session-key") + 1], calls[1][calls[1].indexOf("--session-key") + 1]);
    assert.equal(
      calls[2][calls[2].indexOf("--session") + 1],
      `agent:lead-research:${calls[0][calls[0].indexOf("--session-key") + 1]}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails after the second invalid schema response", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-invalid-"));
  try {
    await assert.rejects(
      runOpenClawResearch(
        { companyName: "Example", metadata: {} },
        dir,
        config(),
        () => {},
        {
          runProcessFn: async () => ({ stdout: cliResponse('{"bad":true}'), stderr: "", code: 0 })
        }
      ),
      /after one repair/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("propagates a private Gateway failure clearly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-"));
  try {
    await assert.rejects(
      runOpenClawResearch(
        { companyName: "Example", metadata: {} },
        dir,
        config(),
        () => {},
        {
          runProcessFn: async () => {
            throw new Error("Gateway unavailable at ws://127.0.0.1:18789");
          }
        }
      ),
      /Gateway unavailable/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enforces worker timeout and termination grace", async () => {
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 25,
      killGraceMs: 25,
      maxOutputBytes: 1024
    }),
    /timed out/
  );
});

test("prefers the absolute worker binary directory for shebang runtimes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "worker-path-"));
  const workerPath = path.join(dir, "worker");
  try {
    await symlink(process.execPath, path.join(dir, "node"));
    await writeFile(workerPath, "#!/usr/bin/env node\nprocess.stdout.write(process.version);\n", "utf8");
    await chmod(workerPath, 0o755);
    const result = await runProcess({
      command: workerPath,
      args: [],
      cwd: dir,
      env: { PATH: "/definitely-not-a-node-directory" },
      timeoutMs: 1000,
      killGraceMs: 100,
      maxOutputBytes: 1024
    });
    assert.equal(result.stdout, process.version);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
