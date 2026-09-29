import { describe, expect, it } from "vitest";
import worker from "../src/index";

const env = { CF_MODE: "mock", DRY_RUN: "true", PROTECTED_NAMES: "www,mail,api", ADMIN_SECRET: "secret", OPENROUTER_MODEL: "openrouter/free" };

describe("suspects endpoint", () => {
  it("requires the admin secret", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/suspects"), env);
    expect(response.status).toBe(401);
  });

  it("returns ranked suspects with dry-run status", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/suspects", { headers: { "x-admin-secret": "secret" } }), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { dryRun: boolean; suspects: { score: number; signals: unknown[] }[] };
    expect(body.dryRun).toBe(true);
    expect(body.suspects.length).toBeGreaterThan(0);
    expect(body.suspects[0].signals.length).toBeGreaterThan(0);
  });
});
