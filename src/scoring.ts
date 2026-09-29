import type { CloudflareClient, DnsRecord, Signal, Suspect } from "./types";

const eligibleTypes = new Set<DnsRecord["type"]>(["A", "AAAA", "CNAME"]);
const suspectNames = new Set(["staging", "old", "v1", "test", "tmp", "legacy", "dev"]);

export function isEligible(record: DnsRecord, zoneName: string, protectedNames: string[]): boolean {
  const name = record.name.toLowerCase().replace(/\.$/, "");
  const zone = zoneName.toLowerCase().replace(/\.$/, "");
  if (!eligibleTypes.has(record.type) || name === zone || !name.endsWith(`.${zone}`)) return false;
  const protectedSet = new Set(protectedNames.map((value) => value.toLowerCase().replace(/\.$/, "")));
  const label = name.slice(0, -(zone.length + 1));
  return !protectedSet.has(name) && !protectedSet.has(label);
}

export async function scoreRecord(record: DnsRecord, client: CloudflareClient, now = new Date()): Promise<Suspect> {
  const signals: Signal[] = [];
  const resolves = await client.targetResolves(record);
  if (resolves === false) signals.push({ kind: "unresolved-target", points: 45, evidence: `Target ${record.content} did not resolve in the configured check.` });

  const ageDays = Math.floor((now.getTime() - new Date(record.modifiedOn).getTime()) / 86_400_000);
  if (Number.isFinite(ageDays) && ageDays >= 180) signals.push({ kind: "stale", points: 20, evidence: `Last modified ${ageDays} days ago (${record.modifiedOn}).` });

  const hits = await client.recentTraffic(record);
  if (hits === 0) signals.push({ kind: "zero-traffic", points: 20, evidence: "Traffic source reports zero recent hits." });

  const matched = record.name.toLowerCase().split(".")[0].split(/[-_]/).filter((part) => suspectNames.has(part));
  if (matched.length) signals.push({ kind: "name-heuristic", points: 15, evidence: `Hostname contains ${[...new Set(matched)].join(", ")}; name alone does not prove disuse.` });

  return { record, score: signals.reduce((sum, signal) => sum + signal.points, 0), signals };
}

export async function listSuspects(client: CloudflareClient, zoneId: string, zoneName: string, protectedNames: string[], now = new Date()): Promise<Suspect[]> {
  const records = (await client.listRecords(zoneId)).filter((record) => isEligible(record, zoneName, protectedNames));
  const scored = await Promise.all(records.map((record) => scoreRecord(record, client, now)));
  return scored.filter((suspect) => suspect.score > 0).sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name));
}
