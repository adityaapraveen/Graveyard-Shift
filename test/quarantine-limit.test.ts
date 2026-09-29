import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { MockClient } from "../src/clients/mock";
import type { AppEnv } from "../src/env";

it("reserves no more than three simultaneous quarantines", async () => {
  const client = new MockClient(env as AppEnv);
  for (const recordId of ["mock-1", "mock-2", "mock-3"]) {
    const proposal = await client.zoneFetch("/propose", { recordId, quarantineSeconds: 120, screamThreshold: 1 });
    expect(proposal.status).toBe(200);
    const { token } = await proposal.json() as { token: string };
    const confirmed = await client.zoneFetch("/confirm", { recordId, token, quarantineSeconds: 120, screamThreshold: 1, workflowId: crypto.randomUUID() });
    expect(confirmed.status).toBe(200);
  }
  const fourth = await client.zoneFetch("/propose", { recordId: "mock-4", quarantineSeconds: 120, screamThreshold: 1 });
  expect(fourth.status).toBe(409);
}, 15_000);
