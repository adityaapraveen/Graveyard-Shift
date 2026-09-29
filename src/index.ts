import { MockClient, createMockRecords } from "./clients/mock";
import { biographyRequest, syncBiography } from "./biography";
import type { AppEnv } from "./env";
import { isEligible, listSuspects, scoreRecord } from "./scoring";
import { recordSinkholeHit, sinkholeResponse } from "./sinkhole";
import type { QuarantineParams } from "./workflow";
import type { Biography } from "./biography";
import { obituaryPage } from "./obituary";
import { clearSessionCookie, isAuthorized, loginPage, sameOrigin, sessionCookie } from "./session";

export { GraveyardAgent } from "./agent";
export { ResourceBiography } from "./biography";
export { MockZone } from "./mock-zone";
export { QuarantineWorkflow } from "./workflow";

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (env.CF_MODE === "mock" && url.hostname.endsWith(".example.test")) {
      const route = await new MockClient(env).zoneFetch(`/route/${url.hostname}`);
      if (route.ok) return sinkholeResponse(request, env, (await route.json() as { recordId: string }).recordId);
      await route.arrayBuffer();
    }
    if (url.pathname.startsWith("/obituary/") && request.method === "GET" && env.CF_MODE === "mock") {
      const recordId = decodeURIComponent(url.pathname.slice("/obituary/".length));
      if (!createMockRecords().some((record) => record.id === recordId)) return json({ error: "Not found" }, 404);
      const response = await biographyRequest(env, "mock-zone", recordId, "/");
      if (!response.ok) return json({ error: "Not found" }, 404);
      const biography = await response.json() as Biography;
      return biography.state === "deleted" && biography.obituary ? obituaryPage(biography.obituary, url.origin) : json({ error: "Obituary not found" }, 404);
    }
    if (url.pathname === "/login" && request.method === "POST") {
      if (!sameOrigin(request)) return json({ error: "Invalid origin" }, 403);
      const form = await request.formData();
      if (!env.ADMIN_SECRET || form.get("secret") !== env.ADMIN_SECRET) return loginPage(true);
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": await sessionCookie(env.ADMIN_SECRET, url.protocol === "https:") } });
    }
    if (url.pathname === "/logout" && request.method === "POST") {
      if (!sameOrigin(request)) return json({ error: "Invalid origin" }, 403);
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": clearSessionCookie(url.protocol === "https:") } });
    }
    const authorization = await isAuthorized(request, env);
    if (!url.pathname.startsWith("/api/")) {
      if (!["/", "/index.html", "/app.js", "/styles.css"].includes(url.pathname)) return json({ error: "Not found" }, 404);
      if (!authorization.allowed) return url.pathname === "/" || url.pathname === "/index.html" ? loginPage() : json({ error: "Unauthorized" }, 401);
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const asset = await env.ASSETS.fetch(url.pathname === "/" ? new Request(`${url.origin}/index.html`) : request);
      const headers = new Headers(asset.headers);
      headers.set("cache-control", "no-store");
      headers.set("x-content-type-options", "nosniff");
      headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      return new Response(asset.body, { status: asset.status, headers });
    }
    if (!authorization.allowed) return json({ error: "Unauthorized" }, 401);
    if (authorization.cookie && request.method !== "GET" && !sameOrigin(request)) return json({ error: "Invalid origin" }, 403);
    if (authorization.cookie && request.method !== "GET" && !request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "JSON required" }, 415);
    if (env.CF_MODE !== "mock") return json({ error: "Real Cloudflare client is scheduled for milestone 5" }, 501);
    const client = new MockClient(env);
    const protectedNames = env.PROTECTED_NAMES.split(",").map((name) => name.trim());
    if (url.pathname === "/api/quarantines" && request.method === "GET") return client.zoneFetch("/quarantines");
    if (url.pathname === "/api/graveyard" && request.method === "GET") {
      const biographies = await Promise.all(createMockRecords().map(async (record) => {
        const response = await biographyRequest(env, "mock-zone", record.id, "/");
        if (!response.ok) { await response.arrayBuffer(); return null; }
        return response.json() as Promise<Biography>;
      }));
      return json({ obituaries: biographies.filter((biography) => biography?.state === "deleted" && biography.obituary).map((biography) => biography!.obituary) });
    }
    if (url.pathname === "/api/suspects" && request.method === "GET") {
      const suspects = await listSuspects(client, "mock-zone", "example.test", protectedNames);
      return json({ zoneId: "mock-zone", dryRun: String(env.DRY_RUN) !== "false", suspects });
    }
    if (url.pathname.startsWith("/api/biography/") && request.method === "GET") {
      const recordId = decodeURIComponent(url.pathname.slice("/api/biography/".length));
      const record = createMockRecords().find((item) => item.id === recordId);
      if (!record || !isEligible(record, "example.test", protectedNames)) return json({ error: "Record not found" }, 404);
      try {
        const existing = await biographyRequest(env, "mock-zone", recordId, "/");
        const biography = existing.ok ? await existing.json() as { state: string } : null;
        if (!existing.ok) await existing.arrayBuffer();
        if (biography && biography.state !== "suspect") return json(biography);
        const active = (await client.listRecords("mock-zone")).find((item) => item.id === recordId);
        if (!active) return biography ? json(biography) : json({ error: "Biography not found" }, 404);
        return json(await syncBiography(env, await scoreRecord(active, client)));
      }
      catch { return json({ error: "Biography unavailable" }, 503); }
    }
    if (url.pathname === "/api/quarantine/propose" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || typeof body.recordId !== "string") return json({ error: "Invalid request" }, 400);
      const proposal = await client.zoneFetch("/propose", body);
      if (!proposal.ok) return proposal;
      return json({ ...await proposal.json() as object, dryRun: String(env.DRY_RUN) !== "false", plan: "Snapshot the record, proxy it to the sinkhole, then restore on a scream or delete after the window." });
    }
    if (url.pathname === "/api/quarantine/confirm" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || typeof body.recordId !== "string" || typeof body.token !== "string") return json({ error: "Invalid request" }, 400);
      const workflowId = crypto.randomUUID();
      const confirmed = await client.zoneFetch("/confirm", { ...body, workflowId });
      if (!confirmed.ok) return confirmed;
      const result = await confirmed.json() as { record: QuarantineParams["snapshot"]; dryRun?: boolean; routePattern: string };
      if (result.dryRun) {
        console.info("DRY_RUN quarantine plan", body.recordId, result.routePattern);
        return json({ dryRun: true, recordId: body.recordId, routePattern: result.routePattern, message: "No DNS or route change was applied." });
      }
      const params: QuarantineParams = {
        zoneId: "mock-zone", recordId: body.recordId, snapshot: result.record,
        quarantineSeconds: body.quarantineSeconds as number, screamThreshold: body.screamThreshold as number,
        deadlineAt: new Date(Date.now() + Number(body.quarantineSeconds) * 1000).toISOString(), workflowId
      };
      try {
        const instance = await env.QUARANTINE_WORKFLOW.create({ id: workflowId, params });
        return json({ dryRun: false, recordId: body.recordId, workflowId: instance.id, routePattern: result.routePattern }, 202);
      } catch {
        await client.zoneFetch("/cancel", { recordId: body.recordId });
        return json({ error: "Workflow could not start; reservation released" }, 503);
      }
    }
    if (url.pathname.startsWith("/api/quarantine/status/") && request.method === "GET") {
      const recordId = url.pathname.slice("/api/quarantine/status/".length);
      const quarantine = await client.zoneFetch(`/quarantine/${recordId}`);
      if (!quarantine.ok) return quarantine;
      const status = await quarantine.json() as { workflowId: string };
      const biography = await biographyRequest(env, "mock-zone", recordId, "/");
      let workflow: unknown = null;
      try { workflow = await (await env.QUARANTINE_WORKFLOW.get(status.workflowId)).status(); } catch { /* Workflow may still be starting. */ }
      return json({ quarantine: status, biography: biography.ok ? await biography.json() : null, workflow });
    }
    if (url.pathname === "/api/quarantine/resurrect" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || typeof body.recordId !== "string") return json({ error: "Invalid request" }, 400);
      const existing = await biographyRequest(env, "mock-zone", body.recordId, "/");
      if (!existing.ok) return existing;
      const biography = await existing.json() as { state: string };
      if (biography.state === "deleted") {
        if (String(env.DRY_RUN) !== "false") return json({ dryRun: true, message: "Would restore the deleted record from its saved snapshot." });
        const restored = await client.zoneFetch("/restore", { recordId: body.recordId });
        if (!restored.ok) return restored;
        await restored.arrayBuffer();
        return biographyRequest(env, "mock-zone", body.recordId, "/resurrected", {});
      }
      return biographyRequest(env, "mock-zone", body.recordId, "/resurrect-request", {});
    }
    if (url.pathname === "/api/dev/simulate-scream" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || typeof body.recordId !== "string") return json({ error: "Invalid request" }, 400);
      return recordSinkholeHit(env, {
        recordId: body.recordId,
        ip: typeof body.ip === "string" ? body.ip : "198.51.100.23",
        userAgent: typeof body.userAgent === "string" ? body.userAgent : "GraveyardDemo/1.0",
        path: typeof body.path === "string" ? body.path : "/",
        country: typeof body.country === "string" ? body.country : "US"
      });
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      let input: unknown;
      try { input = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const stub = env.GraveyardAgent.get(env.GraveyardAgent.idFromName("mock-zone"));
      return stub.fetch(new Request("https://agent.internal/chat", { method: "POST", body: JSON.stringify({ ...(typeof input === "object" && input !== null ? input : {}), zoneId: "mock-zone" }) }));
    }
    if (url.pathname === "/api/chat/history" && request.method === "GET") {
      const stub = env.GraveyardAgent.get(env.GraveyardAgent.idFromName("mock-zone"));
      return stub.fetch("https://agent.internal/history");
    }
    return json({ error: "Not found" }, 404);
  }
};

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
