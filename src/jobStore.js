import crypto from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function requestHash(input) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(input))).digest("hex");
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was already used with a different request body.");
    this.name = "IdempotencyConflictError";
  }
}

export class QueueFullError extends Error {
  constructor() {
    super("The research queue is full.");
    this.name = "QueueFullError";
  }
}

export class SqliteJobStore {
  constructor(config) {
    this.config = config;
    if (config.jobs.databasePath !== ":memory:") {
      mkdirSync(path.dirname(config.jobs.databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(config.jobs.databasePath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        input_json TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        job_dir TEXT,
        worker_json TEXT,
        callback_json TEXT,
        session_key TEXT NOT NULL UNIQUE,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        request_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_updated_idx ON jobs(updated_at);

      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt_no INTEGER NOT NULL,
        engine TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        details_json TEXT,
        UNIQUE(job_id, attempt_no)
      );

      CREATE TABLE IF NOT EXISTS callback_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt_no INTEGER NOT NULL,
        status TEXT NOT NULL,
        status_code INTEGER,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_records (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operational_metrics (
        day TEXT NOT NULL,
        terminal_status TEXT NOT NULL,
        job_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(day, terminal_status)
      );
    `);
  }

  rowToJob(row) {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      input: parseJson(row.input_json, {}),
      result: parseJson(row.result_json),
      error: row.error || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || null,
      jobDir: row.job_dir || null,
      worker: parseJson(row.worker_json),
      callback: parseJson(row.callback_json),
      sessionKey: row.session_key,
      attemptCount: Number(row.attempt_count || 0)
    };
  }

  get(id) {
    return this.rowToJob(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
  }

  list(limit = 100) {
    return this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(1000, Number(limit) || 100)))
      .map((row) => this.rowToJob(row));
  }

  queuedIds() {
    return this.db.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC").all().map((row) => row.id);
  }

  stats() {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all();
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    return {
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      queued: counts.queued || 0,
      running: counts.running || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0
    };
  }

  create(input, idempotencyKey = "") {
    const hash = requestHash(input);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (idempotencyKey) {
        const existing = this.db
          .prepare("SELECT request_hash, job_id FROM idempotency_records WHERE idempotency_key = ?")
          .get(idempotencyKey);
        if (existing) {
          if (existing.request_hash !== hash) throw new IdempotencyConflictError();
          const job = this.get(existing.job_id);
          this.db.exec("COMMIT");
          return { job, reused: true };
        }
      }

      const queued = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'").get();
      if (Number(queued.count) >= this.config.jobs.maxQueued) throw new QueueFullError();

      const id = crypto.randomUUID();
      this.db.prepare(`
        INSERT INTO jobs (
          id, status, input_json, created_at, updated_at, session_key, request_hash
        ) VALUES (?, 'queued', ?, ?, ?, ?, ?)
      `).run(id, JSON.stringify(input), now, now, `job-${id}`, hash);
      if (idempotencyKey) {
        this.db.prepare(`
          INSERT INTO idempotency_records (idempotency_key, request_hash, job_id, created_at)
          VALUES (?, ?, ?, ?)
        `).run(idempotencyKey, hash, id, now);
      }
      const job = this.get(id);
      this.db.exec("COMMIT");
      return { job, reused: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverInterrupted() {
    const interrupted = this.db.prepare("SELECT id, attempt_count FROM jobs WHERE status = 'running'").all();
    const now = new Date().toISOString();
    for (const row of interrupted) {
      if (Number(row.attempt_count) < this.config.jobs.maxAttempts) {
        this.db.prepare(`
          UPDATE jobs SET status = 'queued', updated_at = ?, worker_json = NULL
          WHERE id = ?
        `).run(now, row.id);
      } else {
        this.db.prepare(`
          UPDATE jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
          WHERE id = ?
        `).run("Job was interrupted and exhausted its restart recovery attempt.", now, now, row.id);
      }
      this.db.prepare(`
        UPDATE attempts SET status = 'interrupted', completed_at = ?, error = ?
        WHERE job_id = ? AND status = 'running'
      `).run(now, "Service stopped during the research attempt.", row.id);
    }
    return interrupted.length;
  }

  markRunning(id, engine, jobDir) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT attempt_count FROM jobs WHERE id = ?").get(id);
      if (!row) throw new Error("Job not found.");
      const attemptNo = Number(row.attempt_count) + 1;
      this.db.prepare(`
        UPDATE jobs SET status = 'running', attempt_count = ?, job_dir = ?, updated_at = ?, error = NULL
        WHERE id = ?
      `).run(attemptNo, jobDir, now, id);
      this.db.prepare(`
        INSERT INTO attempts (job_id, attempt_no, engine, status, started_at)
        VALUES (?, ?, ?, 'running', ?)
      `).run(id, attemptNo, engine, now);
      this.db.exec("COMMIT");
      return attemptNo;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateWorker(id, worker) {
    this.db.prepare("UPDATE jobs SET worker_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(worker), new Date().toISOString(), id);
  }

  finishAttempt(id, attemptNo, status, details = null, error = "") {
    this.db.prepare(`
      UPDATE attempts SET status = ?, completed_at = ?, details_json = ?, error = ?
      WHERE job_id = ? AND attempt_no = ?
    `).run(status, new Date().toISOString(), details ? JSON.stringify(details) : null, error || null, id, attemptNo);
  }

  markTerminal(id, status, result, error = "") {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE jobs SET status = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(status, JSON.stringify(result), error || null, now, now, id);
  }

  setCallback(id, callback) {
    this.db.prepare("UPDATE jobs SET callback_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(callback), new Date().toISOString(), id);
  }

  addCallbackDelivery(id, delivery) {
    this.db.prepare(`
      INSERT INTO callback_deliveries (
        job_id, attempt_no, status, status_code, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      delivery.attempt,
      delivery.status,
      delivery.statusCode ?? null,
      delivery.error || null,
      new Date().toISOString()
    );
  }

  purgeExpired(retentionMs) {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const expired = this.db.prepare(`
      SELECT id, job_dir FROM jobs
      WHERE status IN ('completed', 'failed') AND completed_at < ?
    `).all(cutoff);
    const rows = this.db.prepare(`
      SELECT substr(completed_at, 1, 10) AS day, status, COUNT(*) AS count
      FROM jobs
      WHERE status IN ('completed', 'failed') AND completed_at < ?
      GROUP BY day, status
    `).all(cutoff);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        this.db.prepare(`
          INSERT INTO operational_metrics (day, terminal_status, job_count)
          VALUES (?, ?, ?)
          ON CONFLICT(day, terminal_status)
          DO UPDATE SET job_count = job_count + excluded.job_count
        `).run(row.day, row.status, Number(row.count));
      }
      const result = this.db.prepare(`
        DELETE FROM jobs WHERE status IN ('completed', 'failed') AND completed_at < ?
      `).run(cutoff);
      this.db.exec("COMMIT");
      return {
        count: Number(result.changes || 0),
        jobs: expired.map((row) => ({ id: row.id, jobDir: row.job_dir || null }))
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
