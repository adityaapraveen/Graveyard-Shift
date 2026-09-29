# Graveyard Shift

Milestone 1 is an evidence-based suspect detector running in mock mode. No DNS mutation or model call exists yet.

## Run locally

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and set a long random `ADMIN_SECRET`. Keep the OpenRouter key blank until milestone 2.
3. `npm run dev`
4. `curl -H 'x-admin-secret: YOUR_SECRET' http://localhost:8787/api/suspects`

`npm test` runs the scoring, eligibility, and endpoint tests. `npm run typecheck` checks TypeScript.

## How scoring works

`MockClient` seeds 12 DNS records in `example.test`. `listSuspects` excludes the apex, unsupported types, protected names, and names outside the zone before scoring. It awards 45 points for a failed target resolution check, 20 for at least 180 days since modification, 20 for a reported zero traffic count, and 15 for a suspicious hostname token. Each signal carries its evidence. A missing check returns `null` and contributes no points. A score is a review priority, never permission to delete.

The mock's target and traffic checks are seeded facts, not live DNS or analytics measurements. The mock dates are relative to runtime. `PROTECTED_NAMES` is a comma-separated list of full hostnames or relative names, and defaults to `www,mail,api`. `DRY_RUN` defaults to `true`; milestone 1 has no write path regardless of its value.

## Provider and assignment deviation

The latest instruction chooses OpenRouter for milestone 2 biography summaries and chat. `OPENROUTER_MODEL` defaults to `openrouter/free`, and `OPENROUTER_API_KEY` will be a secret. This changes the brief's Workers AI requirement; if the assignment strictly requires Workers AI, OpenRouter alone may not satisfy that rubric. OpenRouter's free router is currently listed as zero cost, but it is an external service with its own limits and model availability. The eventual adapter will request structured JSON and validate it locally, with `unknown` when evidence is insufficient. No cost or provider guarantee is implied by this scaffold.

## Milestones

- **1:** Mock records, eligibility checks, scored suspects, tests. Implemented locally.
- **2:** SQLite-backed biography Durable Object, zone agent chat, OpenRouter adapter and schema validation. Pending.
- **3:** Sinkhole, quarantine Workflow, confirmation tokens, recovery, state-machine tests. Pending.
- **4:** Obituaries and static UI. Pending.
- **5:** Real Cloudflare client, deployment setup, demo. Pending.

No Cloudflare deployment or live API integration has been tested. The pre-existing empty `.git` directory was initialized for the milestone 1 commit.

## Documentation consulted

- [Cloudflare Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/)
- [Workflows step and sleep API](https://developers.cloudflare.com/workflows/build/workers-api/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Workers AI model catalog](https://developers.cloudflare.com/workers-ai/models/) and [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [DNS records API](https://developers.cloudflare.com/api/resources/dns/subresources/records/)
- [Workers routes API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/)
- [GraphQL Analytics plan limits](https://developers.cloudflare.com/analytics/graphql-api/limits/)
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs/) and [free router](https://openrouter.ai/openrouter/free/apps)
