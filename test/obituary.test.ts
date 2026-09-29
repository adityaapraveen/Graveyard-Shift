import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { obituaryFacts, obituaryPage, writeEpitaph } from "../src/obituary";
import type { Biography } from "../src/biography";
import type { AppEnv } from "../src/env";
import { createMockRecords } from "../src/clients/mock";

const appEnv = env as AppEnv;
const record = createMockRecords()[0];
const deleted: Biography = {
  record, snapshot: record, score: 85, signals: [], state: "deleted", quarantine: { workflowId: "workflow-1", deadlineAt: "2026-09-29T00:00:05.000Z", threshold: 1, resurrectRequested: false }, obituary: null,
  events: [
    { at: "2026-09-29T00:00:00.000Z", kind: "quarantined", detail: "" },
    { at: "2026-09-29T00:00:05.000Z", kind: "deleted", detail: "" }
  ], hits: [{ at: "2026-09-29T00:00:02.000Z", ipHash: "redacted", userAgent: "Bot/1", path: "/robots.txt", country: "US", counted: false, reason: "bot", workflowId: "workflow-1" }]
};

describe("obituary facts and publication", () => {
  it("derives cause, survivors, and last words from persisted facts", () => {
    const facts = obituaryFacts(deleted, createMockRecords());
    expect(facts.cause).toBe("Quarantined 5 seconds; 0 counted screams.");
    expect(facts.survivors).toContain("www.example.test");
    expect(facts.lastWords).toContain("/robots.txt");
  });

  it("constrains model output to supplied facts and falls back on bad output", async () => {
    const facts = obituaryFacts(deleted, createMockRecords());
    const testEnv = { ...appEnv, OPENROUTER_API_KEY: "fake-key" } as AppEnv;
    const valid = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ opening: "Here rests", detail: "cause", closing: "Its final state is recorded." }) } }] })) as typeof fetch;
    const result = await writeEpitaph(facts, testEnv, valid);
    expect(result.epitaph).toContain(facts.cause);
    expect(result.epitaphSource).toBe("openrouter");
    const invalid = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ opening: "Here rests", detail: "secret purpose", closing: "Its final state is recorded." }) } }] })) as typeof fetch;
    expect((await writeEpitaph(facts, testEnv, invalid)).epitaphSource).toBe("fallback");
  });

  it("escapes public HTML and Open Graph metadata", async () => {
    const facts = obituaryFacts(deleted, createMockRecords());
    const page = obituaryPage({ ...facts, name: '<script>alert("x")</script>', epitaph: "Goodbye <world>", epitaphSource: "fallback" }, "https://example.test");
    const html = await page.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('property="og:title"');
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the dashboard private and obituaries absent until deletion", async () => {
    const login = await worker.fetch(new Request("https://example.test/"), appEnv);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("Admin secret");
    const asset = await worker.fetch(new Request("https://example.test/app.js"), appEnv);
    expect(asset.status).toBe(401);
    const missing = await worker.fetch(new Request("https://example.test/obituary/mock-1"), appEnv);
    expect(missing.status).toBe(404);
    const publicApi = await worker.fetch(new Request("https://example.test/api/graveyard"), appEnv);
    expect(publicApi.status).toBe(401);
  });

  it("accepts a signed session and blocks cross-origin cookie mutations", async () => {
    const login = await worker.fetch(new Request("https://example.test/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://example.test" }, body: "secret=secret" }), appEnv);
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const dashboard = await worker.fetch(new Request("https://example.test/", { headers: { cookie: cookie! } }), appEnv);
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("Suspect records");
    const blocked = await worker.fetch(new Request("https://example.test/api/quarantine/propose", { method: "POST", headers: { cookie: cookie!, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ recordId: "mock-1", quarantineSeconds: 5, screamThreshold: 1 }) }), appEnv);
    expect(blocked.status).toBe(403);
  });
});
