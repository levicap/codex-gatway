import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  isPrivateAddress,
  signatureHeaders,
  validateCallbackTargetInput
} from "../src/callback.js";
import { createRateLimiter, timingSafeTokenEqual } from "../src/security.js";

test("uses timing-safe digest comparison semantics", () => {
  assert.equal(timingSafeTokenEqual("secret", "secret"), true);
  assert.equal(timingSafeTokenEqual("secret", "other"), false);
  assert.equal(timingSafeTokenEqual("", "secret"), false);
});

test("detects non-public callback addresses", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.2", "169.254.169.254", "::1", "fd00::1", "fe80::1", "fec0::1", "ff02::1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

function invokeRateLimiter(limiter, ip, token) {
  let nextCalled = false;
  let statusCode = null;
  const req = {
    ip,
    socket: {},
    get(name) {
      return name === "authorization" ? `Bearer ${token}` : "";
    }
  };
  const res = {
    set() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json() {}
  };
  limiter(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode };
}

test("rate limits independently by IP and bearer key", () => {
  const byIp = createRateLimiter({ windowMs: 60000, max: 1 });
  assert.equal(invokeRateLimiter(byIp, "203.0.113.1", "token-a").nextCalled, true);
  assert.equal(invokeRateLimiter(byIp, "203.0.113.1", "token-b").statusCode, 429);

  const byKey = createRateLimiter({ windowMs: 60000, max: 1 });
  assert.equal(invokeRateLimiter(byKey, "203.0.113.2", "shared-token").nextCalled, true);
  assert.equal(invokeRateLimiter(byKey, "203.0.113.3", "shared-token").statusCode, 429);
});

test("requires callback allowlist matches", () => {
  assert.equal(
    validateCallbackTargetInput("https://result.hooks.example.com/callback", ["*.hooks.example.com"]).ok,
    true
  );
  assert.equal(
    validateCallbackTargetInput("https://evil.example/callback", ["*.hooks.example.com"]).ok,
    false
  );
  assert.equal(validateCallbackTargetInput("https://127.0.0.1/result", ["127.0.0.1"]).ok, false);
});

test("signs the exact serialized callback body", () => {
  const body = '{"status":"completed"}';
  const now = 1700000000000;
  const headers = signatureHeaders(body, "secret", now);
  const expected = crypto.createHmac("sha256", "secret").update(`1700000000.${body}`).digest("hex");
  assert.equal(headers["X-Webhook-Timestamp"], "1700000000");
  assert.equal(headers["X-Webhook-Signature"], `sha256=${expected}`);
});
