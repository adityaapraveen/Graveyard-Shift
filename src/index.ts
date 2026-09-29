import { MockClient } from "./clients/mock";
import { listSuspects } from "./scoring";

interface Env {
  CF_MODE: string;
  DRY_RUN: string;
  PROTECTED_NAMES: string;
  ADMIN_SECRET: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_API_KEY?: string;
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/suspects" || request.method !== "GET") return json({ error: "Not found" }, 404);
    if (!env.ADMIN_SECRET || request.headers.get("x-admin-secret") !== env.ADMIN_SECRET) return json({ error: "Unauthorized" }, 401);
    if (env.CF_MODE !== "mock") return json({ error: "Real Cloudflare client is scheduled for milestone 5" }, 501);
    const client = new MockClient();
    const suspects = await listSuspects(client, "mock-zone", "example.test", env.PROTECTED_NAMES?.split(",").map((name) => name.trim()) ?? []);
    return json({ zoneId: "mock-zone", dryRun: env.DRY_RUN !== "false", suspects });
  }
};
