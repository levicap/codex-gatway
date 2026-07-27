import { mkdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { domainFromWebsite, mergeExecutives, pickCompanyWebsite, cleanDomain } from "./company.js";
import { readCodexResearchOutput, runCodexResearch } from "./codexAgent.js";
import { searchApolloExecutives, supplementExecutivesWithApollo } from "./apolloClient.js";
import { postCallback } from "./callback.js";

async function deliverCallback(job, payload, config) {
  if (!job.input.callbackUrl) {
    return {
      status: "skipped_no_callback_url"
    };
  }

  return postCallback(job.input.callbackUrl, payload, config);
}

export function createJobStore(config) {
  const jobs = new Map();
  const queue = [];
  let active = 0;

  function snapshot(job) {
    const queueIndex = queue.findIndex((queuedJob) => queuedJob.id === job.id);
    const queuePosition = queueIndex >= 0 ? queueIndex + 1 : null;
    const codexLogUrl = job.codex || job.jobDir ? `/jobs/${job.id}/codex-log` : null;
    const statusMessage =
      job.status === "queued"
        ? `Waiting for a worker slot. Queue position: ${queuePosition || "unknown"}. Codex logs will appear after the job starts.`
        : job.status === "running"
          ? "Codex/Apollo enrichment is running."
          : null;

    return {
      id: job.id,
      status: job.status,
      statusMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt || null,
      queuePosition,
      input: job.input,
      result: job.result || null,
      error: job.error || null,
      jobDir: job.jobDir || null,
      codex: job.codex || null,
      codexLogUrl,
      callback: job.callback || null
    };
  }

  function save(job, patch) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return job;
  }

  async function runJob(job) {
    const jobDir = path.join(config.jobs.runsDir, job.id);
    save(job, { status: "running", jobDir });
    await mkdir(jobDir, { recursive: true });

    try {
      let codex = null;
      let codexError = null;
      try {
        codex = await runCodexResearch(job.input, jobDir, config, (progress) => {
          save(job, {
            codex: {
              ...(job.codex || {}),
              ...progress
            }
          });
        });
      } catch (error) {
        codexError = error;
        const lateOutputPath = job.codex?.outputPath;
        if (lateOutputPath) {
          try {
            codex = {
              status: "completed_late",
              durationMs: Date.now() - Date.parse(job.codex.startedAt || job.createdAt),
              research: await readCodexResearchOutput(lateOutputPath),
              outputPath: lateOutputPath,
              eventsPath: job.codex?.eventsPath,
              stderrPath: job.codex?.stderrPath,
              eventSummary: {
                recoveredAfterError: error.message
              }
            };
            codexError = null;
          } catch {
            // Keep the original Codex error when no valid final JSON exists.
          }
        }
      }

      const research = codex?.research || {
        companyName: job.input.companyName,
        website: job.input.companyWebsite,
        domain: domainFromWebsite(job.input.companyWebsite),
        confidence: 0,
        summary: "",
        sourceUrls: [],
        publicExecutives: []
      };

      const website = pickCompanyWebsite(job.input.companyWebsite, research.website, research.domain);
      const domain = cleanDomain(research.domain) || domainFromWebsite(website);
      const apollo = await searchApolloExecutives(
        {
          companyName: research.companyName || job.input.companyName,
          domain,
          limit: job.input.limit,
          metadata: job.input.metadata
        },
        config
      );

      let keyExecutives = mergeExecutives({
        apolloExecutives: apollo.executives,
        publicExecutives: research.publicExecutives,
        limit: job.input.limit,
        metadata: job.input.metadata
      });
      const apolloSupplement = await supplementExecutivesWithApollo(
        keyExecutives,
        {
          companyName: research.companyName || job.input.companyName,
          domain
        },
        config
      );
      keyExecutives = apolloSupplement.executives;

      const payload = {
        jobId: job.id,
        status: "completed",
        completedAt: new Date().toISOString(),
        clientName: job.input.clientName,
        company: {
          inputName: job.input.companyName,
          resolvedName: research.companyName || job.input.companyName,
          website,
          domain,
          summary: research.summary || "",
          confidence: Number(research.confidence || 0),
          sourceUrls: Array.isArray(research.sourceUrls) ? research.sourceUrls.filter(Boolean) : []
        },
        keyExecutives,
        enrichment: {
          codex: codex
            ? {
                status: "completed",
                durationMs: codex.durationMs,
                eventSummary: codex.eventSummary,
                outputPath: codex.outputPath,
                eventsPath: codex.eventsPath
              }
            : {
                status: "failed",
                error: codexError?.message || "Codex failed."
              },
          apollo: {
            status: apollo.status,
            total: apollo.total,
            endpoint: apollo.endpoint || null,
            enrichmentEndpoint: apollo.enrichmentEndpoint || null,
            enrichedCount: apollo.enrichedCount || 0,
            warnings: apollo.warnings || [],
            leadContext: apollo.leadContext || null,
            supplementedCount: apolloSupplement.supplementedCount,
            supplementWarnings: apolloSupplement.warnings,
            error: apollo.error || null
          }
        },
        metadata: job.input.metadata
      };

      const callback = await deliverCallback(job, payload, config);
      save(job, {
        status: "completed",
        completedAt: payload.completedAt,
        result: payload,
        callback
      });
    } catch (error) {
      const payload = {
        jobId: job.id,
        status: "failed",
        completedAt: new Date().toISOString(),
        clientName: job.input.clientName,
        company: {
          inputName: job.input.companyName,
          website: job.input.companyWebsite
        },
        error: error.message,
        metadata: job.input.metadata
      };

      const callback = await deliverCallback(job, payload, config);
      save(job, {
        status: "failed",
        completedAt: payload.completedAt,
        error: error.message,
        result: payload,
        callback
      });
    }
  }

  async function drain() {
    while (active < config.jobs.maxConcurrent && queue.length) {
      const job = queue.shift();
      active += 1;
      runJob(job)
        .catch((error) => {
          save(job, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: error.message
          });
        })
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function create(input) {
    const job = {
      id: crypto.randomUUID(),
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      input
    };
    jobs.set(job.id, job);
    queue.push(job);
    drain();
    return snapshot(job);
  }

  function get(jobId) {
    const job = jobs.get(jobId);
    return job ? snapshot(job) : null;
  }

  function list() {
    return [...jobs.values()]
      .map((job) => snapshot(job))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  function stats() {
    return {
      active,
      queued: queue.length,
      maxConcurrent: config.jobs.maxConcurrent,
      total: jobs.size
    };
  }

  function purgeOldJobs() {
    const cutoff = Date.now() - config.jobs.retentionMs;
    for (const [id, job] of jobs.entries()) {
      if (Date.parse(job.updatedAt) < cutoff) jobs.delete(id);
    }
  }

  return {
    create,
    get,
    list,
    stats,
    purgeOldJobs
  };
}
