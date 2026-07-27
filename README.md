# OpenClaw Decision-Maker Research Webhook

A private-by-default Express facade for asynchronous public-web lead research.
Each accepted request creates a persistent SQLite job, invokes the isolated
OpenClaw `lead-research` agent through the official Codex harness, and returns
up to three verified current decision-makers with canonical LinkedIn profile
URLs.

The Express service is the only public component. OpenClaw Gateway and Express
both bind to loopback; put Caddy or Nginx in front of Express for public HTTPS.

## What is enforced

- At least one identity anchor: company name, company website, or person name.
- 64 KB request bodies and 20,000-character job descriptions.
- Timing-safe bearer authentication and per-IP/per-key rate limits.
- Persistent jobs, attempts, idempotency records, and callback deliveries.
- Two workers, a 100-job queue, one restart recovery attempt, and 24-hour data
  retention.
- Codex Hosted Search in live mode, public `web_fetch`, and an isolated managed
  browser only.
- No Apollo, email enrichment, shell, filesystem, messaging, cron, subagents,
  Gateway administration, or personal browser profile.
- A non-LinkedIn source for the current person/company relationship plus
  LinkedIn identity evidence for every returned URL.
- Strict JSON Schema validation and one no-research repair turn.
- Actual tool reporting from OpenClaw's metadata audit ledger.
- HTTPS callbacks restricted to configured public hosts and pinned DNS
  resolutions, with HMAC signatures.

Zero, one, or two verified profiles is a successful result. The worker never
invents candidates to reach three.

## Requirements

- Node.js 24.15+ (this machine uses NVM Node 24.18.0)
- OpenClaw `2026.7.1-2`
- Docker and Google Chrome/Chromium
- An authenticated Codex CLI/OpenAI account

Install application dependencies:

```bash
npm install
cp .env.example .env
```

Set at minimum:

```dotenv
RESEARCH_API_KEY=replace-with-a-long-random-value
OPENCLAW_BIN=/home/moez/.nvm/versions/node/v24.18.0/bin/openclaw
```

Callbacks are optional. When no callback is needed, leave `callbackUrl` out of
the request. When callbacks are used, also set an independent
`CALLBACK_SECRET` and `CALLBACK_ALLOWED_HOSTS`. The allowlist accepts exact
hosts and entries such as `*.example.com`.

## OpenClaw bootstrap

The host was configured with:

```bash
nvm install 24
nvm alias default 24
npm install -g openclaw@2026.7.1-2
openclaw plugins install @openclaw/codex@2026.7.1 --pin
openclaw doctor --fix --non-interactive --yes
openclaw agents add lead-research \
  --workspace /home/moez/Documents/leads-search/codex-gatway/openclaw/workspace-lead-research \
  --model openai/gpt-5.6-terra \
  --non-interactive
./scripts/build-openclaw-sandboxes.sh
openclaw gateway install
openclaw gateway start
```

The complete non-secret agent shape is documented in
`openclaw/config-reference.json5`. It is a reference, not a patch to apply
blindly, because OpenClaw array patches replace the complete `agents.list`.

The active OpenClaw configuration also pins:

- `gateway.mode=local`, `gateway.bind=loopback`, and token auth.
- `openai/gpt-5.6-terra` through the Codex agent runtime.
- Medium reasoning for `lead-research`.
- Live Codex Hosted Search with no separate managed search provider.
- A session-scoped Docker sandbox with no host workspace access.
- Agent-level access only to `web_search`, `web_fetch`, and `browser`; shell,
  process, and filesystem calls are explicitly denied.
- The sandbox exec-server preview, which lets native Codex Hosted Search run
  inside the Docker-backed native surface. Its second-layer native tool
  entries are still blocked by the agent-level deny policy.
- The `research` managed-browser profile; host/personal browser control is
  denied.

Verify before serving traffic:

```bash
openclaw config validate
openclaw plugins doctor
openclaw models status --agent lead-research
openclaw sandbox explain --agent lead-research --json
openclaw gateway status
openclaw browser doctor --json
npm test
```

## Run the API

```bash
npm start
```

Health:

```bash
curl -sS http://127.0.0.1:3000/health
```

### Upwork-style test request

```bash
curl -sS -X POST http://127.0.0.1:3000/webhooks/decision-maker-research \
  -H "Authorization: Bearer $RESEARCH_API_KEY" \
  -H "Idempotency-Key: upwork-022077947047914219285-v1" \
  -H "Content-Type: application/json" \
  --data-binary '{
    "personName": "Erik Walenza",
    "location": "Portland, United States",
    "jobTitle": "AI process automation",
    "jobUrl": "https://www.upwork.com/jobs/~022077947047914219285",
    "jobDescription": "",
    "metadata": {
      "source": "Upwork",
      "upworkJobId": "~022077947047914219285",
      "clientScore": 5,
      "totalSpendUsd": 10434.49,
      "averageHourlyRateUsd": 15.022681673131673,
      "budgetHourlyUsd": 0,
      "extractedNames": ["Erik Walenza"]
    }
  }'
```

The immediate response is:

```json
{
  "jobId": "uuid",
  "status": "queued",
  "statusUrl": "/jobs/uuid",
  "idempotencyReused": false
}
```

Poll it:

```bash
curl -sS \
  -H "Authorization: Bearer $RESEARCH_API_KEY" \
  http://127.0.0.1:3000/jobs/JOB_ID
```

The same `Idempotency-Key` and normalized payload returns the original job.
Reusing the key with a different payload returns `409`.

### General request

```json
{
  "companyName": "Optional company",
  "companyWebsite": "https://optional.example",
  "personName": "Optional known person",
  "location": "Optional location",
  "jobTitle": "Optional job title",
  "jobDescription": "Optional identity clues",
  "jobUrl": "https://optional-job-url.example",
  "callbackUrl": "https://hooks.your-company.example/result",
  "metadata": {}
}
```

Job title and description are identity clues only. They do not change the
leadership functions that are selected or ranked.

## Completed result

```json
{
  "jobId": "uuid",
  "status": "completed",
  "target": {
    "resolvedCompanyName": "Example Inc.",
    "website": "https://example.com",
    "domain": "example.com",
    "confidence": 0.96,
    "sourceUrls": ["https://example.com/about"]
  },
  "decisionMakers": [
    {
      "name": "Person Name",
      "title": "Chief Executive Officer",
      "company": "Example Inc.",
      "linkedinUrl": "https://www.linkedin.com/in/person-slug",
      "confidence": 0.94,
      "relevanceReason": "Founder and current CEO",
      "sourceUrls": ["https://example.com/team"],
      "linkedinEvidenceUrls": [
        "https://www.linkedin.com/in/person-slug"
      ]
    }
  ],
  "coverage": {
    "requested": 3,
    "returned": 1,
    "status": "partial"
  },
  "research": {
    "model": "openai/gpt-5.6-terra",
    "toolsUsed": ["codex_hosted_search", "web_fetch"],
    "browserUsed": false,
    "durationMs": 90000,
    "warnings": []
  },
  "metadata": {}
}
```

`coverage.status` is `complete`, `partial`, or `none`. Ambiguous input is a
successful zero-result job with an `ambiguous_target` warning. Transport,
Gateway, model, timeout, or repeated-schema errors produce a failed job.

## Callbacks

The terminal `result` object is POSTed unchanged. With `CALLBACK_SECRET`
configured, the request includes:

- `X-Webhook-Timestamp`
- `X-Webhook-Signature: sha256=<hex>`

The signed content is:

```text
<timestamp>.<exact JSON request body>
```

Callback redirects are not followed. All DNS answers must be public; the
connection is pinned to the validated answer to prevent DNS rebinding.

## Persistence and recovery

SQLite data is stored at `data/jobs.sqlite` by default. Jobs left `running`
during a restart are requeued once because research is read-only. A second
interruption marks the job failed. Terminal input/result rows and their run
directories are removed after 24 hours; only daily terminal-status counts
remain.

Set `RESEARCH_ENGINE=codex` for the temporary direct-`codex exec` rollback
worker. `/webhooks/executive-enrichment` is a deprecated compatibility alias
for one release; new integrations should use only
`/webhooks/decision-maker-research`.

Production examples are in [deploy/Caddyfile.example](deploy/Caddyfile.example)
and [deploy/codex-gateway.service](deploy/codex-gateway.service). Install the
webhook example as a user service in the same user manager as OpenClaw:

```bash
mkdir -p data job-runs codex-workdir ~/.config/systemd/user
cp deploy/codex-gateway.service \
  ~/.config/systemd/user/decision-maker-webhook.service
systemctl --user daemon-reload
systemctl --user enable --now decision-maker-webhook.service
```

The example contains this checkout's absolute paths. Update them when deploying
another checkout or user.

## Evaluation gate

Do not switch production traffic solely because the live smoke test passes.
Build a manually verified set of at least 20 leads and require at least 95%
LinkedIn-match precision. Track coverage separately and never increase it by
accepting uncertain identities.
