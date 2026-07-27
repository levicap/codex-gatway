import crypto from "node:crypto";

export function timingSafeTokenEqual(provided, expected) {
  if (!provided || !expected) return false;
  const providedDigest = crypto.createHash("sha256").update(String(provided)).digest();
  const expectedDigest = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

export function bearerTokenFromRequest(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function createRateLimiter({ windowMs, max }) {
  const windows = new Map();
  const maximumTrackedWindows = 10000;
  let requestCount = 0;

  function removeExpired(now) {
    for (const [key, value] of windows) {
      if (value.resetAt <= now) windows.delete(key);
    }
  }

  function consume(key, now) {
    requestCount += 1;
    if (requestCount % 512 === 0 || windows.size >= maximumTrackedWindows) {
      removeExpired(now);
    }

    const current = windows.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && windows.size >= maximumTrackedWindows) {
        return { limited: true, resetAt: now + windowMs };
      }
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return { limited: false, resetAt: now + windowMs };
    }

    current.count += 1;
    return { limited: current.count > max, resetAt: current.resetAt };
  }

  return function rateLimit(req, res, next) {
    const token = bearerTokenFromRequest(req);
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const keys = [`ip:${ip}`];
    if (token) {
      const tokenKey = crypto.createHash("sha256").update(token).digest("hex");
      keys.push(`key:${tokenKey}`);
    }

    for (const key of keys) {
      const result = consume(key, now);
      if (result.limited) {
        res.set("Retry-After", String(Math.max(1, Math.ceil((result.resetAt - now) / 1000))));
        res.status(429).json({ error: "Rate limit exceeded." });
        return;
      }
    }

    next();
  };
}
