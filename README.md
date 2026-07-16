# Codex Executive Webhook

Express webhook that receives a company, returns a job id, runs `codex exec` as the research agent, enriches executive matches with Apollo.io, then lets you poll until the final result is ready. Optional callback delivery is still supported when you include `callbackUrl`.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Configure `.env`:

- `APOLLO_API_KEY`: Apollo.io API key for people search.
- `CODEX_BIN`: Codex CLI binary, defaults to `codex`.
- `CODEX_LIVE_SEARCH=true`: passes `--search` to Codex so the CLI can use live web search.
- `CODEX_SANDBOX=read-only`: default because this worker only needs research output.
- `CODEX_ENABLE_APOLLO_MCP=true`: exposes Apollo to Codex as local MCP tools during `codex exec`.
- `APOLLO_INCLUDE_EMAILS=false`: leaves Apollo personal-email reveal off. Business/work emails returned by normal enrichment are still included when available.
- `WEBHOOK_AUTH_TOKEN`: optional bearer token for inbound calls.
- `CALLBACK_SECRET`: optional HMAC secret for outbound callbacks when `callbackUrl` is provided.

Codex authentication is handled by the CLI. Either run `codex login` on the host or provide `CODEX_API_KEY` or `CODEX_ACCESS_TOKEN` in the server environment for trusted automation.

## Endpoint

`POST /webhooks/executive-enrichment`

Create a polling job:

```bash
curl.exe -s -X POST "http://localhost:3000/webhooks/executive-enrichment" ^
  -H "Content-Type: application/json" ^
  -d "{\"clientName\":\"Internal CRM\",\"companyName\":\"OpenAI\",\"companyWebsite\":\"https://openai.com\",\"limit\":10,\"metadata\":{\"crmRecordId\":\"abc123\"}}"
```

Equivalent JSON body:

```json
{
  "clientName": "Internal CRM",
  "companyName": "OpenAI",
  "companyWebsite": "https://openai.com",
  "limit": 10,
  "metadata": {
    "crmRecordId": "abc123"
  }
}
```

`companyWebsite` is optional. If missing, Codex is asked to find the official website through web research.

Response:

```json
{
  "jobId": "6df1094a-7f58-4502-a8ec-2ed8f8c3b13a",
  "status": "queued",
  "statusUrl": "/jobs/6df1094a-7f58-4502-a8ec-2ed8f8c3b13a"
}
```

Poll status until `status` is `completed` or `failed`:

```bash
curl.exe -s "http://localhost:3000/jobs/6df1094a-7f58-4502-a8ec-2ed8f8c3b13a"
```

For a callback-based job, include `callbackUrl` in the POST body:

```json
{
  "clientName": "Internal CRM",
  "companyName": "OpenAI",
  "companyWebsite": "https://openai.com",
  "callbackUrl": "https://example.com/webhooks/enrichment-result"
}
```

## Result Payload

The completed job `result` looks like this:

```json
{
  "jobId": "6df1094a-7f58-4502-a8ec-2ed8f8c3b13a",
  "status": "completed",
  "clientName": "Internal CRM",
  "company": {
    "inputName": "OpenAI",
    "resolvedName": "OpenAI",
    "website": "https://openai.com",
    "domain": "openai.com",
    "summary": "Brief company summary from public sources.",
    "confidence": 0.93,
    "sourceUrls": ["https://openai.com/about"]
  },
  "keyExecutives": [
    {
      "name": "Example Person",
      "title": "Chief Executive Officer",
      "email": "person@example.com",
      "emailType": "public_work",
      "emailSource": "codex_public",
      "emailSourceUrls": ["https://example.com/leadership"],
      "source": "apollo+codex_public",
      "linkedinUrl": "https://www.linkedin.com/in/example",
      "confidence": 0.85,
      "sourceUrls": ["https://example.com/leadership"]
    }
  ],
  "enrichment": {
    "codex": {
      "status": "completed",
      "durationMs": 12345
    },
    "apollo": {
      "status": "completed",
      "total": 12
    }
  },
  "metadata": {
    "crmRecordId": "abc123"
  }
}
```

When `CALLBACK_SECRET` is set, callbacks include:

- `X-Webhook-Timestamp`
- `X-Webhook-Signature: sha256=<hmac>`

The signature is HMAC-SHA256 over `<timestamp>.<json-body>`.

## Status

`GET /jobs/:jobId` returns the in-memory job snapshot. Jobs are not persisted across server restarts.

## Notes

- This service uses Codex CLI through `codex exec`; it does not call the OpenAI API directly from application code.
- Apollo is exposed to Codex as MCP tools: `apollo_people_search` and `apollo_people_enrich`. The server still runs Apollo after Codex as a fallback/merge step.
- Apollo defaults to `https://api.apollo.io/api/v1/mixed_people/api_search` for search and `/people/match` for enrichment. Override `APOLLO_BASE_URL`, `APOLLO_PEOPLE_SEARCH_PATH`, or `APOLLO_PEOPLE_ENRICHMENT_PATH` if your Apollo account uses different endpoints.
- Codex searches public web sources for executive business emails first. Apollo fills missing emails when enrichment returns one. Set `APOLLO_INCLUDE_EMAILS=true` only if your workflow is allowed to reveal/process Apollo personal emails.
