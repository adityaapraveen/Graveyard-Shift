import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { RealClient } from "../src/clients/real";
import type { AppEnv } from "../src/env";
import worker from "../src/index";

const appEnv = env as AppEnv;
const zoneId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const recordId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const raw = { id: recordId, zone_id: zoneId, name: "legacy.example.org", type: "CNAME", content: "old.example.net", created_on: "2024-01-01T00:00:00Z", modified_on: "2024-02-01T00:00:00Z", proxied: false, ttl: 300, comment: "owner unknown", tags: ["review"] };

const envelope = (result: unknown) => Response.json({ success: true, result });

describe("real Cloudflare client", () => {
  it("maps records, skips unavailable traffic, and sends exact DNS and route writes", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 3 });
      if (url.pathname.endsWith("/dns_records") && init?.method === "POST") return envelope({ ...raw, ...(JSON.parse(String(init.body)) as object), id: "cccccccccccccccccccccccccccccccc" });
      if (url.pathname.endsWith("/dns_records")) return envelope([raw]);
      if (url.pathname.endsWith(`/${recordId}`) && init?.method === "PATCH") return envelope({ ...raw, ...(JSON.parse(String(init.body)) as object) });
      if (url.pathname.endsWith(`/${recordId}`)) return envelope(raw);
      if (url.pathname.endsWith("/workers/routes") && init?.method === "POST") return envelope({ id: "route-1", pattern: "legacy.example.org/*", script: "graveyard-shift" });
      if (url.pathname.endsWith("/workers/routes")) return envelope([]);
      return envelope({ id: "route-1" });
    }) as typeof fetch;
    const client = new RealClient(appEnv, fakeFetch);
    const records = await client.listRecords(zoneId);
    expect(records).toHaveLength(1);
    expect(records[0].raw?.comment).toBe("owner unknown");
    expect(await client.targetResolves(records[0])).toBe(false);
    expect(await client.recentTraffic(records[0])).toBeNull();
    await client.createRoute("legacy.example.org/*");
    await client.quarantineRecord(records[0]);
    await client.restoreRecord(records[0]);
    expect(calls.find((call) => call.method === "POST" && call.path.endsWith("/workers/routes"))?.body).toEqual({ pattern: "legacy.example.org/*", script: "graveyard-shift" });
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ content: "sinkhole.invalid", proxied: true, ttl: 1 });
    expect(calls.filter((call) => call.method === "PATCH").at(-1)?.body).toMatchObject({ content: "old.example.net", proxied: false, ttl: 300, comment: "owner unknown", tags: ["review"] });
    expect(JSON.stringify(calls)).not.toContain("fake-token");
  });

  it("refuses a zone mismatch before any request", async () => {
    const fakeFetch = vi.fn() as unknown as typeof fetch;
    await expect(new RealClient(appEnv, fakeFetch).listRecords("wrong-zone")).rejects.toThrow("Zone mismatch");
    expect(fakeFetch).not.toHaveBeenCalled();
  });
  it("blocks every write when DRY_RUN is enabled", async () => {
    const fakeFetch = vi.fn() as unknown as typeof fetch;
    const client = new RealClient({ ...appEnv, DRY_RUN: "true" } as AppEnv, fakeFetch);
    await expect(client.createRoute("legacy.example.org/*")).rejects.toThrow("DRY_RUN");
    await expect(client.quarantineRecord((await new RealClient(appEnv, async () => envelope(raw) as Response).getRecord(recordId))!)).rejects.toThrow("DRY_RUN");
    expect(fakeFetch).not.toHaveBeenCalled();
  });
  it("serves ranked suspects through the real-mode API without a DNS write", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === `/client/v4/zones/${zoneId}`) return envelope({ name: "example.org" });
      if (url.pathname.endsWith("/dns_records")) return envelope([{ ...raw, type: "A", content: "192.0.2.10" }]);
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    try {
      const realEnv = { ...appEnv, CF_MODE: "real", DRY_RUN: "true" } as unknown as AppEnv;
      const response = await worker.fetch(new Request("https://dashboard.example.net/api/suspects", { headers: { "x-admin-secret": "secret" } }), realEnv);
      expect(response.status).toBe(200);
      const body = await response.json() as { mode: string; dryRun: boolean; suspects: { record: { id: string } }[] };
      expect(body).toMatchObject({ mode: "real", dryRun: true });
      expect(body.suspects[0].record.id).toBe(recordId);
      expect(calls.every((call) => call.startsWith("GET"))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});
