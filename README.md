# Graveyard Shift

Milestones 1 and 2 run in mock mode. The Worker ranks suspect DNS records, stores per-record biographies in SQLite-backed Durable Objects, and routes chat through a zone-scoped Cloudflare Agent and OpenRouter. No DNS mutation exists yet.

## Run locally

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and set a long random `ADMIN_SECRET` and your `OPENROUTER_API_KEY`.
3. `npm run dev`
4. `curl -H 'x-admin-secret: YOUR_SECRET' http://localhost:8787/api/suspects`
5. `curl -H 'x-admin-secret: YOUR_SECRET' http://localhost:8787/api/biography/mock-1`
6. `curl -N -X POST -H 'x-admin-secret: YOUR_SECRET' -H 'content-type: application/json' -d '{"message":"Why does old-api.example.test exist, can I kill it?"}' http://localhost:8787/api/chat`

`GET /api/chat/history` returns the latest 40 messages. The `/api/chat` response uses Server-Sent Events. The Agent obtains and validates a complete OpenRouter JSON response before sending answer chunks, so the first chunk waits for the model call. A later UI can consume this endpoint without exposing the OpenRouter key to the browser.

`npm test` runs scoring, eligibility, Durable Object, endpoint, and model-adapter tests in the Cloudflare Workers runtime. `npm run typecheck` checks TypeScript. The Workers test runner must be allowed to bind localhost.

## How scoring works

`MockClient` seeds 12 DNS records in `example.test`. `listSuspects` excludes the apex, unsupported types, protected names, and names outside the zone before scoring. It awards 45 points for a failed target resolution check, 20 for at least 180 days since modification, 20 for a reported zero traffic count, and 15 for a suspicious hostname token. Each signal carries its evidence. A missing check returns `null` and contributes no points. A score is a review priority, never permission to delete.

The mock's target and traffic checks are seeded facts, not live DNS or analytics measurements. Mock dates use a fixed September 29, 2026 seed so repeated reads do not invent modifications. `PROTECTED_NAMES` is a comma-separated list of full hostnames or relative names, and defaults to `www,mail,api`. `DRY_RUN` defaults to `true`; milestone 1 has no write path regardless of its value.

## Provider and assignment deviation

The latest instruction chooses OpenRouter for biography summaries and chat. `OPENROUTER_MODEL` defaults to `openrouter/free`; keep `OPENROUTER_API_KEY` in a Worker secret. This changes the brief's Workers AI requirement; if the assignment strictly requires Workers AI, OpenRouter alone may not satisfy that rubric. OpenRouter's free router is currently listed as zero cost, but it is an external service with its own limits and model availability. DNS record names, targets, scores, and signal evidence are sent to OpenRouter. The adapter requests strict structured JSON, validates the output locally, rejects unknown evidence kinds, and always reports the record's purpose as `unknown`. The final answer is assembled from the stored facts, so model text cannot authorize a DNS action.

`ResourceBiography` persists the full observed record, a separate snapshot, score, signals, lifecycle state, event log, and an empty sinkhole-hit table for milestone 3. `GraveyardAgent` persists conversation history for the mock zone. The first observation is logged once; later changed metadata produces a `modified` event. These facts live outside Workflow state. Neither the chat agent nor the biography endpoint has DNS write capability.

## Milestones

- **1:** Mock records, eligibility checks, scored suspects, tests. Implemented locally.
- **2:** SQLite-backed biography Durable Object, zone agent chat, OpenRouter adapter and schema validation. Implemented locally; a live OpenRouter request has not been tested because no key was provided.
- **3:** Sinkhole, quarantine Workflow, confirmation tokens, recovery, state-machine tests. Pending.
- **4:** Obituaries and static UI. Pending.
- **5:** Real Cloudflare client, deployment setup, demo. Pending.

No Cloudflare deployment or live DNS API integration has been tested. Tests use mock records and stubbed OpenRouter responses. The first Cloudflare deployment still needs account bindings and secrets.

## Documentation consulted

- [Cloudflare Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/)
- [Workflows step and sleep API](https://developers.cloudflare.com/workflows/build/workers-api/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Workers AI model catalog](https://developers.cloudflare.com/workers-ai/models/) and [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [DNS records API](https://developers.cloudflare.com/api/resources/dns/subresources/records/)
- [Workers routes API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/)
- [GraphQL Analytics plan limits](https://developers.cloudflare.com/analytics/graphql-api/limits/)
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs/) and [free router](https://openrouter.ai/openrouter/free/apps)
- [Current Cloudflare Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/)
