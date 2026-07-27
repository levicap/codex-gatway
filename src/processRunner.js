import { spawn } from "node:child_process";
import path from "node:path";

export function sanitizedWorkerEnv() {
  const env = { ...process.env };
  for (const key of [
    "RESEARCH_API_KEY",
    "WEBHOOK_AUTH_TOKEN",
    "CALLBACK_SECRET",
    "APOLLO_API_KEY"
  ]) {
    delete env[key];
  }
  return env;
}

export function runProcess({
  command,
  args,
  cwd,
  env = sanitizedWorkerEnv(),
  input = "",
  timeoutMs,
  killGraceMs,
  maxOutputBytes,
  onStart = () => {}
}) {
  return new Promise((resolve, reject) => {
    const workerEnv = { ...env };
    if (path.isAbsolute(command)) {
      const commandDirectory = path.dirname(command);
      const pathEntries = String(workerEnv.PATH || "").split(path.delimiter).filter(Boolean);
      workerEnv.PATH = [commandDirectory, ...pathEntries.filter((entry) => entry !== commandDirectory)]
        .join(path.delimiter);
    }
    const child = spawn(command, args, {
      cwd,
      env: workerEnv,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let killTimer = null;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      fn(value);
    };

    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      killTimer.unref?.();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeoutTimer.unref?.();

    onStart(child);

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate();
        settle(reject, new Error(`Worker output exceeded ${maxOutputBytes} bytes.`));
        return;
      }
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate();
        settle(reject, new Error(`Worker output exceeded ${maxOutputBytes} bytes.`));
        return;
      }
      stderr += chunk.toString();
    });

    child.on("error", (error) => settle(reject, error));
    child.on("close", (code, signal) => {
      if (timedOut) {
        settle(reject, new Error(`Worker timed out after ${timeoutMs}ms and was terminated.`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().slice(-2000);
        settle(
          reject,
          new Error(`Worker exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.${detail ? ` ${detail}` : ""}`)
        );
        return;
      }
      settle(resolve, { stdout, stderr, code });
    });

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}
