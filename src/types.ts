export type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV";

export interface DnsRecord {
  id: string;
  zoneId: string;
  name: string;
  type: RecordType;
  content: string;
  createdOn: string;
  modifiedOn: string;
  proxied: boolean;
  ttl: number;
}

export interface CloudflareClient {
  listRecords(zoneId: string): Promise<DnsRecord[]>;
  targetResolves(record: DnsRecord): Promise<boolean | null>;
  recentTraffic(record: DnsRecord): Promise<number | null>;
}

export interface Signal {
  kind: "unresolved-target" | "stale" | "zero-traffic" | "name-heuristic";
  points: number;
  evidence: string;
}

export interface Suspect {
  record: DnsRecord;
  score: number;
  signals: Signal[];
}
