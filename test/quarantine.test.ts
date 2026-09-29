import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";
import type { Biography } from "../src/biography";

const appEnv = env as AppEnv;
const auth = { "x-admin-secret": "secret" };

async function api(path: string, body?: unknown, authorized = true): Promise<Response> {
  return worker.fetch(new Request(`https://example.test${path}`, body === undefined
    ? { headers: authorized ? auth : {} }
    : { method: "POST", headers: { ...(authorized ? auth : {}), "content-type": "application/json" }, body: JSON.stringify(body) }), appEnv);
}

async function statusOnly(response: Response): Promise<number> {
  const status = response.status;
  await response.arrayBuffer();
  return status;
}

async function proposal(recordId: string, quarantineSeconds = 3, screamThreshold = 1) {
  const response = await api("/api/quarantine/propose", { recordId, quarantineSeconds, screamThreshold });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ token: string; record: { content: string; proxied: boolean } }>;
}

async function waitFor(recordId: string, state: string, timeoutMs = 15_000): Promise<{ quarantine: { state: string }; biography: Biography }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await api(`/api/quarantine/status/${recordId}`);
    if (response.ok) {
      const body = await response.json() as { quarantine: { state: string }; biography: Biography; workflow: { status?: string } | null };
      if (body.quarantine.state === state && body.biography?.state === state &&
        (state === "quarantined" || body.workflow?.status === "complete")) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${recordId} to become ${state}`);
}

describe("mock quarantine state machine", () => {
  it("requires a one-time confirmation and restores on a unique human scream", async () => {
    const recordId = "mock-1";
    const plan = await proposal(recordId, 5, 2);
    expect(plan.record.proxied).toBe(false);
    const mismatched = await api("/api/quarantine/confirm", { recordId, token: plan.token, quarantineSeconds: 5, screamThreshold: 1 });
    expect(await statusOnly(mismatched)).toBe(409);
    const confirmed = await api("/api/quarantine/confirm", { recordId, token: plan.token, quarantineSeconds: 5, screamThreshold: 2 });
    expect(await statusOnly(confirmed)).toBe(202);
    const repeated = await api("/api/quarantine/confirm", { recordId, token: plan.token, quarantineSeconds: 5, screamThreshold: 2 });
    expect(await statusOnly(repeated)).toBe(409);
    await waitFor(recordId, "quarantined");

    const bot = await api("/api/dev/simulate-scream", { recordId, ip: "198.51.100.10", userAgent: "SearchBot/1", path: "/bot", country: "US" });
    expect((await bot.json() as { counted: boolean }).counted).toBe(false);
    const first = await worker.fetch(new Request("https://old-api.example.test/app", { headers: { "cf-connecting-ip": "198.51.100.11", "user-agent": "Browser/1", "cf-ipcountry": "US" } }), appEnv);
    expect(await statusOnly(first)).toBe(503);
    const duplicate = await api("/api/dev/simulate-scream", { recordId, ip: "198.51.100.11", userAgent: "Browser/1", path: "/app", country: "US" });
    expect((await duplicate.json() as { counted: boolean }).counted).toBe(false);
    const second = await api("/api/dev/simulate-scream", { recordId, ip: "198.51.100.12", userAgent: "Browser/1", path: "/other", country: "US" });
    expect((await second.json() as { uniqueHits: number }).uniqueHits).toBe(2);
    const final = await waitFor(recordId, "resurrected");
    expect(final.biography.snapshot.content).toBe(plan.record.content);
    expect(final.biography.hits.map((hit) => hit.reason)).toEqual(["bot", "unique", "duplicate", "unique"]);
    const records = await api("/api/suspects");
    expect((await records.json() as { suspects: { record: { id: string; content: string; proxied: boolean } }[] }).suspects.find((item) => item.record.id === recordId)?.record).toMatchObject({ content: plan.record.content, proxied: false });
    const afterRestore = await worker.fetch(new Request("https://old-api.example.test/app"), appEnv);
    expect(await statusOnly(afterRestore)).toBe(404);
    const secondPlan = await proposal(recordId, 2, 1);
    expect(await statusOnly(await api("/api/quarantine/confirm", { recordId, token: secondPlan.token, quarantineSeconds: 2, screamThreshold: 1 }))).toBe(202);
    const secondCycle = await waitFor(recordId, "deleted");
    expect(secondCycle.biography.hits).toHaveLength(4);
  });

  it("deletes after the window when nobody screams while retaining the snapshot", async () => {
    const recordId = "mock-2";
    const plan = await proposal(recordId, 2, 1);
    const confirmed = await api("/api/quarantine/confirm", { recordId, token: plan.token, quarantineSeconds: 2, screamThreshold: 1 });
    expect(await statusOnly(confirmed)).toBe(202);
    const final = await waitFor(recordId, "deleted");
    expect(final.biography.snapshot.content).toBe(plan.record.content);
    const suspects = await api("/api/suspects");
    expect((await suspects.json() as { suspects: { record: { id: string } }[] }).suspects.some((item) => item.record.id === recordId)).toBe(false);
    const restore = await api("/api/quarantine/resurrect", { recordId });
    expect(restore.status).toBe(200);
    const restored = await restore.json() as Biography;
    expect(restored.state).toBe("resurrected");
    const records = await api("/api/suspects");
    expect((await records.json() as { suspects: { record: { id: string; content: string } }[] }).suspects.find((item) => item.record.id === recordId)?.record.content).toBe(plan.record.content);
  });

  it("honors an administrator's resurrect-now request", async () => {
    const recordId = "mock-3";
    const plan = await proposal(recordId, 5, 2);
    expect(await statusOnly(await api("/api/quarantine/confirm", { recordId, token: plan.token, quarantineSeconds: 5, screamThreshold: 2 }))).toBe(202);
    await waitFor(recordId, "quarantined");
    expect(await statusOnly(await api("/api/quarantine/resurrect", { recordId }))).toBe(200);
    const final = await waitFor(recordId, "resurrected");
    expect(final.biography.quarantine?.resurrectRequested).toBe(true);
  });

  it("rejects protected records and unauthenticated mutation requests", async () => {
    const protectedRecord = await api("/api/quarantine/propose", { recordId: "mock-11", quarantineSeconds: 2, screamThreshold: 1 });
    expect(await statusOnly(protectedRecord)).toBe(403);
    const unauthenticated = await api("/api/quarantine/propose", { recordId: "mock-3", quarantineSeconds: 2, screamThreshold: 1 }, false);
    expect(await statusOnly(unauthenticated)).toBe(401);
  });
});
