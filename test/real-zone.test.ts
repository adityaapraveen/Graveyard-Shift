import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { routeOverlaps } from "../src/real-zone";

const appEnv = env as AppEnv;
const zoneId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const recordId = "dddddddddddddddddddddddddddddddd";
const original = { id: recordId, zone_id: zoneId, name: "old.example.org", type: "A", content: "192.0.2.10", created_on: "2024-01-01T00:00:00Z", modified_on: "2024-02-01T00:00:00Z", proxied: false, ttl: 300 };
const envelope = (result: unknown) => Response.json({ success: true, result });
const stub = appEnv.RealZone.get(appEnv.RealZone.idFromName(zoneId));
const zone = (path: string, body?: unknown) => stub.fetch(new Request(`https://real-zone.internal${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) }));

afterEach(() => vi.unstubAllGlobals());

describe("real zone guardrails", () => {
  it("detects exact and wildcard routes before attaching a sinkhole", () => {
    expect(routeOverlaps("old.example.org", "old.example.org/private/*")).toBe(true);
    expect(routeOverlaps("old.example.org", "*.example.org/*")).toBe(true);
    expect(routeOverlaps("old.example.org", "https://*example.org/*")).toBe(true);
    expect(routeOverlaps("old.example.org", "other.example.org/*")).toBe(false);
  });
  it("requires a snapshot-bound token and restores DNS and route", async () => {
    let record = { ...original };
    let route: { id: string; pattern: string; script: string } | null = null;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      if (url.pathname === `/client/v4/zones/${zoneId}`) return envelope({ name: "example.org" });
      if (url.pathname.endsWith(`/dns_records/${recordId}`)) {
        if (method === "GET") return envelope(record);
        if (method === "PATCH") { record = { ...record, ...JSON.parse(String(init?.body)) }; return envelope(record); }
      }
      if (url.pathname.endsWith("/workers/routes")) {
        if (method === "GET") return envelope(route ? [route] : []);
        if (method === "POST") { route = { id: "route-1", ...JSON.parse(String(init?.body)) }; return envelope(route); }
      }
      if (url.pathname.endsWith("/workers/routes/route-1") && method === "DELETE") { route = null; return envelope({ id: "route-1" }); }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    });
    const proposal = await zone("/propose", { recordId, quarantineSeconds: 3600, screamThreshold: 1 });
    expect(proposal.status).toBe(200);
    const plan = await proposal.json() as { token: string };
    const wrong = await zone("/confirm", { recordId, token: plan.token, quarantineSeconds: 3600, screamThreshold: 2, workflowId: "wf-1" });
    expect(wrong.status).toBe(409);
    const confirmed = await zone("/confirm", { recordId, token: plan.token, quarantineSeconds: 3600, screamThreshold: 1, workflowId: "wf-1" });
    expect(confirmed.status).toBe(200);
    const replay = await zone("/confirm", { recordId, token: plan.token, quarantineSeconds: 3600, screamThreshold: 1, workflowId: "wf-1" });
    expect(replay.status).toBe(409);
    const applied = await zone("/apply", { recordId });
    expect(applied.status).toBe(200);
    expect(record).toMatchObject({ content: "192.0.2.0", proxied: true, ttl: 1 });
    expect((route as { pattern: string } | null)?.pattern).toBe("old.example.org/*");
    expect((await zone("/route/old.example.org")).status).toBe(200);
    const restored = await zone("/restore", { recordId });
    expect(restored.status).toBe(200);
    expect(record).toMatchObject({ content: original.content, proxied: false, ttl: 300 });
    expect(route).toBeNull();
    expect((await zone("/route/old.example.org")).status).toBe(404);
    expect(calls.indexOf(`POST /client/v4/zones/${zoneId}/workers/routes`)).toBeLessThan(calls.indexOf(`PATCH /client/v4/zones/${zoneId}/dns_records/${recordId}`));
  }, 20_000);
  it("stops deletion on drift and can recreate a deleted record from its snapshot", async () => {
    const nextId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const replacementId = "ffffffffffffffffffffffffffffffff";
    const initial = { ...original, id: nextId, name: "staging.example.org" };
    let record: typeof initial | null = { ...initial };
    let route: { id: string; pattern: string; script: string } | null = null;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)); const method = init?.method ?? "GET";
      if (url.pathname === `/client/v4/zones/${zoneId}`) return envelope({ name: "example.org" });
      if (url.pathname.endsWith(`/dns_records/${nextId}`)) {
        if (method === "GET") return record ? envelope(record) : new Response("", { status: 404 });
        if (method === "PATCH") { record = { ...record!, ...JSON.parse(String(init?.body)) }; return envelope(record); }
        if (method === "DELETE") { record = null; return envelope({ id: nextId }); }
      }
      if (url.pathname.endsWith("/dns_records")) {
        if (method === "GET") return envelope(record ? [record] : []);
        if (method === "POST") { record = { ...initial, ...JSON.parse(String(init?.body)), id: replacementId }; return envelope(record); }
      }
      if (url.pathname.endsWith("/workers/routes")) {
        if (method === "GET") return envelope(route ? [route] : []);
        if (method === "POST") { route = { id: "route-2", ...JSON.parse(String(init?.body)) }; return envelope(route); }
      }
      if (url.pathname.endsWith("/workers/routes/route-2") && method === "DELETE") { route = null; return envelope({ id: "route-2" }); }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    });
    const proposed = await zone("/propose", { recordId: nextId, quarantineSeconds: 3600, screamThreshold: 1 });
    const plan = await proposed.json() as { token: string };
    expect((await zone("/confirm", { recordId: nextId, token: plan.token, quarantineSeconds: 3600, screamThreshold: 1, workflowId: "wf-2" })).status).toBe(200);
    expect((await zone("/apply", { recordId: nextId })).status).toBe(200);
    record = { ...record!, content: "192.0.2.99" };
    expect((await zone("/delete", { recordId: nextId })).status).toBe(409);
    expect(record).not.toBeNull();
    record = { ...record!, content: "192.0.2.0" };
    expect((await zone("/delete", { recordId: nextId })).status).toBe(200);
    expect(record).toBeNull();
    const restored = await zone("/restore", { recordId: nextId });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ state: "resurrected", restoredId: replacementId });
    expect(record).toMatchObject({ content: initial.content, proxied: false, ttl: 300 });
    expect(route).toBeNull();
  }, 20_000);
});
