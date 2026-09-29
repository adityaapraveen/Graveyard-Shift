import { describe, expect, it } from "vitest";
import { MockClient } from "../src/clients/mock";
import { scoreRecord } from "../src/scoring";
import { chooseEvidence, renderEvidenceSummary } from "../src/openrouter";
import type { Biography } from "../src/biography";

async function biography(): Promise<Biography> {
  const client = new MockClient();
  const record = (await client.listRecords("mock-zone"))[0];
  const suspect = await scoreRecord(record, client);
  return { ...suspect, snapshot: record, state: "suspect", events: [], hits: [], quarantine: null };
}

const fakeResponse = (value: unknown): typeof fetch => (async (_url: unknown, init: RequestInit) => {
  const request = JSON.parse(init.body as string) as { model: string; provider: { require_parameters: boolean }; response_format: unknown };
  expect(request.model).toBe("liquid/lfm-2.5-2.6b:free");
  expect(request.provider.require_parameters).toBe(true);
  expect(request.response_format).toBeTruthy();
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
}) as typeof fetch;

describe("OpenRouter evidence selection", () => {
  it("accepts only known signal kinds and renders facts from the biography", async () => {
    const bio = await biography();
    const choice = await chooseEvidence(bio, "test-key", "liquid/lfm-2.5-2.6b:free", fakeResponse({ purpose: "unknown", evidenceKinds: ["unresolved-target"], assessment: "investigate" }));
    const answer = renderEvidenceSummary(bio, choice);
    expect(answer).toContain("Purpose: unknown");
    expect(answer).toContain("gone.example.test");
    expect(answer).toContain("No DNS change has been made");
  });

  it("rejects a claimed purpose and unavailable evidence", async () => {
    const bio = await biography();
    await expect(chooseEvidence(bio, "test-key", "liquid/lfm-2.5-2.6b:free", fakeResponse({ purpose: "old staging", evidenceKinds: [], assessment: "investigate" }))).rejects.toThrow();
    await expect(chooseEvidence(bio, "test-key", "liquid/lfm-2.5-2.6b:free", fakeResponse({ purpose: "unknown", evidenceKinds: ["not-a-signal"], assessment: "investigate" }))).rejects.toThrow();
  });

  it("fails closed when the provider returns malformed JSON", async () => {
    const bio = await biography();
    const fetcher = (async () => Response.json({ choices: [{ message: { content: "not json" } }] })) as typeof fetch;
    await expect(chooseEvidence(bio, "test-key", "liquid/lfm-2.5-2.6b:free", fetcher)).rejects.toThrow("invalid JSON");
  });

  it("rejects a model that could charge money", async () => {
    await expect(chooseEvidence(await biography(), "test-key", "openai/gpt-4o", fakeResponse({}))).rejects.toThrow("Only free");
  });
});
