import { describe, expect, it } from "vitest";
import { MockClient } from "../src/clients/mock";
import { isEligible, listSuspects, scoreRecord } from "../src/scoring";
import type { CloudflareClient, DnsRecord } from "../src/types";

const client = new MockClient();
const zone = "example.test";

describe("suspect scoring", () => {
  it("ranks eligible mock records and attaches evidence for each point source", async () => {
    const suspects = await listSuspects(client, "mock-zone", zone, ["www"]);
    expect(suspects[0].record.name).toBe("old-api.example.test");
    expect(suspects[0].score).toBe(100);
    expect(suspects[0].signals.map((signal) => signal.points).reduce((a, b) => a + b, 0)).toBe(suspects[0].score);
    expect(suspects.every((item, index) => index === 0 || suspects[index - 1].score >= item.score)).toBe(true);
  });

  it("does not treat unavailable traffic as zero traffic", async () => {
    const record = (await client.listRecords("mock-zone")).find((item) => item.name === "tmp.example.test")!;
    const result = await scoreRecord(record, client);
    expect(result.signals.some((signal) => signal.kind === "zero-traffic")).toBe(false);
  });

  it("does not score absent evidence", async () => {
    const record = (await client.listRecords("mock-zone")).find((item) => item.name === "app.example.test")!;
    const result = await scoreRecord(record, client);
    expect(result.score).toBe(0);
  });

  it("does not claim an unresolved target when the check is unavailable", async () => {
    const record = (await client.listRecords("mock-zone"))[0];
    const unavailable: CloudflareClient = {
      listRecords: async () => [record],
      targetResolves: async () => null,
      recentTraffic: async () => null
    };
    expect((await scoreRecord(record, unavailable)).signals.some((signal) => signal.kind === "unresolved-target")).toBe(false);
  });
});

describe("eligibility guardrails", () => {
  it("refuses apex, unsupported types, protected names, and records outside the zone", async () => {
    const records = await client.listRecords("mock-zone");
    for (const name of ["example.test", "mail.example.test", "www.example.test", "test.example.test"]) {
      expect(isEligible(records.find((record) => record.name === name)!, zone, ["www"])).toBe(false);
    }
    expect(isEligible({ ...records[0], name: "old-api.other.test" } as DnsRecord, zone, [])).toBe(false);
    expect(isEligible(records[0], zone, ["old-api"])).toBe(false);
    expect(isEligible(records[0], zone, ["OLD-API.EXAMPLE.TEST."])).toBe(false);
  });
});
