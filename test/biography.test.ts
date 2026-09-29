import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";
import type { Biography } from "../src/biography";

const appEnv = env as AppEnv;
const auth = { "x-admin-secret": "secret" };

describe("biography Durable Object", () => {
  it("stores the full snapshot and does not duplicate the first observation", async () => {
    const url = "https://example.test/api/biography/mock-1";
    const first = await worker.fetch(new Request(url, { headers: auth }), appEnv);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as Biography;
    expect(firstBody.snapshot).toEqual(firstBody.record);
    expect(firstBody.state).toBe("suspect");
    expect(firstBody.events.map((event) => event.kind)).toEqual(["observed"]);

    const second = await worker.fetch(new Request(url, { headers: auth }), appEnv);
    const secondBody = await second.json() as Biography;
    expect(secondBody.events).toHaveLength(1);
    expect(secondBody.score).toBe(100);
  });

  it("refuses biography reads for ineligible records", async () => {
    for (const id of ["mock-9", "mock-10", "mock-11", "mock-12"]) {
      const response = await worker.fetch(new Request(`https://example.test/api/biography/${id}`, { headers: auth }), appEnv);
      expect(response.status).toBe(404);
    }
  });
});

describe("zone agent", () => {
  it("keeps conversation history and requires an OpenRouter key for chat", async () => {
    const history = await worker.fetch(new Request("https://example.test/api/chat/history", { headers: auth }), appEnv);
    expect(history.status).toBe(200);
    expect((await history.json() as { messages: unknown[] }).messages).toEqual([]);
    const chat = await worker.fetch(new Request("https://example.test/api/chat", {
      method: "POST", headers: auth, body: JSON.stringify({ message: "Why does old-api.example.test exist?" })
    }), appEnv);
    expect(chat.status).toBe(503);
    const protectedChat = await worker.fetch(new Request("https://example.test/api/chat", {
      method: "POST", headers: auth, body: JSON.stringify({ message: "Why does www.example.test exist?" })
    }), appEnv);
    expect(protectedChat.status).toBe(400);
  });
});
