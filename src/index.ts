import { MockClient } from "./clients/mock";
import { syncBiography } from "./biography";
import type { AppEnv } from "./env";
import { isEligible, listSuspects, scoreRecord } from "./scoring";

export { GraveyardAgent } from "./agent";
export { ResourceBiography } from "./biography";

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    if (!env.ADMIN_SECRET || request.headers.get("x-admin-secret") !== env.ADMIN_SECRET) return json({ error: "Unauthorized" }, 401);
    if (env.CF_MODE !== "mock") return json({ error: "Real Cloudflare client is scheduled for milestone 5" }, 501);
    const client = new MockClient();
    const protectedNames = env.PROTECTED_NAMES.split(",").map((name) => name.trim());
    if (url.pathname === "/api/suspects" && request.method === "GET") {
      const suspects = await listSuspects(client, "mock-zone", "example.test", protectedNames);
      return json({ zoneId: "mock-zone", dryRun: String(env.DRY_RUN) !== "false", suspects });
    }
    if (url.pathname.startsWith("/api/biography/") && request.method === "GET") {
      const recordId = decodeURIComponent(url.pathname.slice("/api/biography/".length));
      const record = (await client.listRecords("mock-zone")).find((item) => item.id === recordId);
      if (!record || !isEligible(record, "example.test", protectedNames)) return json({ error: "Record not found" }, 404);
      try { return json(await syncBiography(env, await scoreRecord(record, client))); }
      catch { return json({ error: "Biography unavailable" }, 503); }
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
