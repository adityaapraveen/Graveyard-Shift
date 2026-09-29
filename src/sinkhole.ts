import { biographyRequest } from "./biography";
import { MockClient } from "./clients/mock";
import { RealClient, realConfig } from "./clients/real";
import type { AppEnv } from "./env";

export interface SimulatedHit { recordId: string; ip: string; userAgent: string; path: string; country: string }

export async function recordSinkholeHit(env: AppEnv, hit: SimulatedHit): Promise<Response> {
  const real = String(env.CF_MODE) === "real";
  const zone = real ? new RealClient(env) : new MockClient(env);
  const zoneId = real ? realConfig(env).zoneId : "mock-zone";
  const quarantine = await zone.zoneFetch(`/quarantine/${hit.recordId}`);
  if (!quarantine.ok) return Response.json({ error: "No quarantine" }, { status: 404 });
  const status = await quarantine.json() as { state: string };
  if (status.state !== "quarantined") return Response.json({ error: "Record is not quarantined" }, { status: 409 });
  const ipHash = await hashIp(hit.ip, env.ADMIN_SECRET);
  const response = await biographyRequest(env, zoneId, hit.recordId, "/hit", {
    ipHash,
    userAgent: hit.userAgent,
    hitPath: hit.path,
    country: hit.country
  });
  if (!real || !response.ok) return response;
  const result = await response.json() as { counted: boolean; uniqueHits: number };
  const biography = await biographyRequest(env, zoneId, hit.recordId, "/");
  if (biography.ok) {
    const current = await biography.json() as { state: string; quarantine: { threshold: number } | null };
    if (current.state === "quarantined" && current.quarantine && result.uniqueHits >= current.quarantine.threshold) {
      try {
        const restored = await zone.zoneFetch("/restore", { recordId: hit.recordId });
        if (restored.ok) await biographyRequest(env, zoneId, hit.recordId, "/resurrected", {});
        else await restored.arrayBuffer();
      } catch { console.warn("Immediate resurrection failed; Workflow will retry"); }
    }
  } else await biography.arrayBuffer();
  return Response.json(result);
}

export async function sinkholeResponse(request: Request, env: AppEnv, recordId: string): Promise<Response> {
  const url = new URL(request.url);
  const response = await recordSinkholeHit(env, {
    recordId,
    ip: request.headers.get("cf-connecting-ip") || "0.0.0.0",
    userAgent: request.headers.get("user-agent") || "unknown",
    path: url.pathname + url.search,
    country: request.headers.get("cf-ipcountry") || "unknown"
  });
  if (!response.ok) {
    await response.arrayBuffer();
    return Response.json({ error: "Record is not quarantined" }, { status: response.status });
  }
  await response.arrayBuffer();
  return new Response("This DNS record is in quarantine. Contact the zone administrator if you need it restored.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

async function hashIp(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`graveyard-ip:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
