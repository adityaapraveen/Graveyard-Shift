import type { CloudflareClient, DnsRecord } from "../types";

const zoneId = "mock-zone";
const seedEpoch = Date.UTC(2026, 8, 29);
const dateDaysAgo = (days: number): string => new Date(seedEpoch - days * 86_400_000).toISOString();

interface MockSeed {
  name: string;
  type: DnsRecord["type"];
  content: string;
  ageDays: number;
  resolves: boolean | null;
  hits: number | null;
}

const seeds: MockSeed[] = [
  { name: "old-api.example.test", type: "CNAME", content: "gone.example.test", ageDays: 810, resolves: false, hits: 0 },
  { name: "staging.example.test", type: "A", content: "192.0.2.10", ageDays: 620, resolves: true, hits: 0 },
  { name: "legacy.example.test", type: "CNAME", content: "archive.example.test", ageDays: 500, resolves: true, hits: 0 },
  { name: "v1.example.test", type: "AAAA", content: "2001:db8::1", ageDays: 420, resolves: false, hits: 4 },
  { name: "tmp.example.test", type: "A", content: "192.0.2.11", ageDays: 250, resolves: true, hits: null },
  { name: "dev.example.test", type: "A", content: "192.0.2.12", ageDays: 20, resolves: true, hits: 0 },
  { name: "app.example.test", type: "A", content: "192.0.2.13", ageDays: 8, resolves: true, hits: 990 },
  { name: "docs.example.test", type: "CNAME", content: "pages.example.test", ageDays: 310, resolves: true, hits: 60 },
  { name: "example.test", type: "A", content: "192.0.2.14", ageDays: 1000, resolves: false, hits: 0 },
  { name: "mail.example.test", type: "MX", content: "mailhost.example.test", ageDays: 800, resolves: false, hits: 0 },
  { name: "www.example.test", type: "CNAME", content: "gone.example.test", ageDays: 800, resolves: false, hits: 0 },
  { name: "test.example.test", type: "TXT", content: "old", ageDays: 800, resolves: false, hits: 0 }
];

export class MockClient implements CloudflareClient {
  private readonly records: DnsRecord[];
  private readonly evidence = new Map<string, Pick<MockSeed, "resolves" | "hits">>();

  constructor() {
    this.records = seeds.map((seed, index) => {
      const id = `mock-${index + 1}`;
      this.evidence.set(id, { resolves: seed.resolves, hits: seed.hits });
      return {
        id,
        zoneId,
        name: seed.name,
        type: seed.type,
        content: seed.content,
        createdOn: dateDaysAgo(seed.ageDays + 100),
        modifiedOn: dateDaysAgo(seed.ageDays),
        proxied: false,
        ttl: 300
      };
    });
  }

  async listRecords(requestedZoneId: string): Promise<DnsRecord[]> {
    return requestedZoneId === zoneId ? this.records.map((record) => ({ ...record })) : [];
  }

  async targetResolves(record: DnsRecord): Promise<boolean | null> {
    return this.evidence.get(record.id)?.resolves ?? null;
  }

  async recentTraffic(record: DnsRecord): Promise<number | null> {
    return this.evidence.get(record.id)?.hits ?? null;
  }
}
