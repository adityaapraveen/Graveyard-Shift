# Graveyard Shift

Milestones 1–3 run in mock mode. The Worker ranks suspect DNS records, stores per-record biographies in SQLite-backed Durable Objects, routes chat through a zone-scoped Cloudflare Agent and OpenRouter, and runs reversible mock quarantines through a Workflow. No real Cloudflare DNS write path exists yet.

## Run locally

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and set a long random `ADMIN_SECRET` and your `OPENROUTER_API_KEY`. Wrangler can also load an ignored `.env` file with `--env-file .env`.
3. `npm run dev`
4. `curl -H 'x-admin-secret: YOUR_SECRET' http://localhost:8787/api/suspects`
5. `curl -H 'x-admin-secret: YOUR_SECRET' http://localhost:8787/api/biography/mock-1`
6. `curl -N -X POST -H 'x-admin-secret: YOUR_SECRET' -H 'content-type: application/json' -d '{"message":"Why does old-api.example.test exist, can I kill it?"}' http://localhost:8787/api/chat`

`GET /api/chat/history` returns the latest 40 messages. The `/api/chat` response uses Server-Sent Events. The Agent obtains and validates a complete OpenRouter JSON response before sending answer chunks, so the first chunk waits for the model call. A later UI can consume this endpoint without exposing the OpenRouter key to the browser.

`npm test` runs scoring, eligibility, Durable Object, endpoint, Workflow, sinkhole, and model-adapter tests in the Cloudflare Workers runtime. Tests replace the OpenRouter key with an empty value and never call the live provider. `npm run typecheck` checks TypeScript. The Workers test runner must be allowed to bind localhost.

## Mock quarantine demo

`DRY_RUN=true` is the default. To let **only the mock zone** change, run `npx wrangler dev --local --env-file .env --var DRY_RUN:false`. The project has no real DNS client yet.

1. `POST /api/quarantine/propose` with `{"recordId":"mock-1","quarantineSeconds":5,"screamThreshold":1}`. The response contains a short-lived, one-time confirmation token and the original record.
2. Show the plan to the administrator. Only after their explicit confirmation, `POST /api/quarantine/confirm` with the same fields plus `"token":"..."`. The server binds the token to the record, window, threshold, and unchanged record snapshot. Under the default dry run, confirmation reports the intended route and changes nothing.
3. `GET /api/quarantine/status/mock-1` returns the Workflow status, countdown deadline, biography, and hit log.
4. In mock mode, `POST /api/dev/simulate-scream` with `{"recordId":"mock-1","ip":"198.51.100.50","userAgent":"Browser/1","path":"/app","country":"US"}`. This endpoint requires the admin secret. A request to a quarantined mock hostname also reaches the sinkhole and receives HTTP 503.
5. `POST /api/quarantine/resurrect` with `{"recordId":"mock-1"}` requests restoration during quarantine. The same endpoint restores a deleted mock record from its saved snapshot after the Workflow completes.

All `/api/` endpoints require `x-admin-secret`. The sinkhole hostname route is public by design. Bot user agents are logged but do not count as screams. Repeated hits from the same IP hash and user agent count once. The IP is stored as an HMAC hash; the raw address is not stored. A single mock zone accepts at most three simultaneous quarantines. Windows are limited to 1–120 seconds in mock mode to make the demo fast.

`MockZone` is a third SQLite-backed Durable Object, one per zone. It persists the fake DNS records, routes, reservations, and hashed confirmation tokens so separate Worker requests see the same state. This replaces the brief's purely in-memory fake zone while keeping the `MockClient` interface. `ResourceBiography` stores the full pre-change snapshot, hit log, events, score, and lifecycle state. Workflow steps are retriable; the zone and biography transitions are idempotent. The Workflow state is coordination data, not the source of biography history.

The sinkhole only sees HTTP(S) requests routed through the Worker. It cannot detect mail, SSH, direct-IP access, cached DNS use, or other non-web traffic. A quiet window therefore does **not** prove a record is unused. Real DNS proxying and Workers route creation remain milestone 5 work.

## How scoring works

`MockClient` seeds 12 DNS records in `example.test`. `listSuspects` excludes the apex, unsupported types, protected names, and names outside the zone before scoring. It awards 45 points for a failed target resolution check, 20 for at least 180 days since modification, 20 for a reported zero traffic count, and 15 for a suspicious hostname token. Each signal carries its evidence. A missing check returns `null` and contributes no points. A score is a review priority, never permission to delete.

The mock's target and traffic checks are seeded facts, not live DNS or analytics measurements. Mock dates use a fixed September 29, 2026 seed so repeated reads do not invent modifications. `PROTECTED_NAMES` is a comma-separated list of full hostnames or relative names, and defaults to `www,mail,api`. `DRY_RUN` defaults to `true`; it blocks all mock DNS and route mutations until explicitly disabled for a local demo.

## Provider and assignment deviation

The latest instruction chooses OpenRouter for biography summaries and chat. `OPENROUTER_MODEL` defaults to `liquid/lfm-2.5-2.6b:free`; only `:free` models or `openrouter/free` are accepted, and `OPENROUTER_API_KEY` stays in a Worker secret. The free router initially exhausted its short output budget or hit a shared upstream limit; the specific free model returned schema-validated JSON in a live local chat test. Free model availability can change. This provider choice changes the brief's Workers AI requirement; if the assignment strictly requires Workers AI, OpenRouter alone may not satisfy that rubric. DNS record names, targets, scores, and signal evidence are sent to OpenRouter. The adapter requests strict structured JSON, validates it locally, rejects unknown evidence kinds, and always reports the record's purpose as `unknown`. The final answer is assembled from stored facts, so model text cannot authorize a DNS action.

`GraveyardAgent` persists conversation history for the mock zone. The first biography observation is logged once; later changed metadata produces a `modified` event. Neither the chat agent nor the model has a DNS write capability.

## Milestones

- **1:** Mock records, eligibility checks, scored suspects, tests. Implemented locally.
- **2:** SQLite-backed biography Durable Object, zone agent chat, OpenRouter adapter and schema validation. Implemented locally; the supplied key passed one end-to-end local chat test.
- **3:** Sinkhole, quarantine Workflow, confirmation tokens, recovery, state-machine tests. Implemented in mock mode; resurrection, deletion, post-deletion recovery, three-slot limit, and default dry run were verified locally.
- **4:** Obituaries and static UI. Pending.
- **5:** Real Cloudflare client, deployment setup, demo. Pending.

No Cloudflare deployment or live DNS API integration has been tested. The live OpenRouter chat test used mock DNS facts and your locally supplied key. The first Cloudflare deployment still needs account bindings and secrets. The current chat endpoint explains records; a chat tool that proposes quarantine has not yet been added, so confirmation uses the explicit API route.

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
