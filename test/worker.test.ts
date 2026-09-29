import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/index";
import type { AppEnv } from "../src/env";

const appEnv = env as AppEnv;

describe("suspects endpoint", () => {
  it("requires the admin secret", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/suspects"), appEnv);
    expect(response.status).toBe(401);
  });

  it("returns ranked suspects with configured dry-run status", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/suspects", { headers: { "x-admin-secret": "secret" } }), appEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as { dryRun: boolean; suspects: { score: number; signals: unknown[] }[] };
    expect(body.dryRun).toBe(false);
    expect(body.suspects.length).toBeGreaterThan(0);
    expect(body.suspects[0].signals.length).toBeGreaterThan(0);
  });
});
