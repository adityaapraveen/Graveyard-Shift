import type { AppEnv } from "../env";
import type { CloudflareClient, DnsRecord } from "../types";

type ApiEnvelope<T> = { success: boolean; result: T; errors?: { code: number; message: string }[]; result_info?: { total_pages?: number } };
type RawRecord = { id: string; zone_id: string; name: string; type: string; content: string; created_on: string; modified_on: string; proxied?: boolean; ttl: number; comment?: string; tags?: string[]; settings?: { ipv4_only?: boolean; ipv6_only?: boolean } };
export type RawRoute = { id: string; pattern: string; script?: string };

export function realConfig(env: AppEnv): { zoneId: string; zoneName: string; scriptName: string } {
  const zoneId = env.CF_ZONE_ID?.trim();
  const zoneName = env.CF_ZONE_NAME?.trim().toLowerCase().replace(/\.$/, "");
  const scriptName = env.SINKHOLE_SCRIPT_NAME?.trim();
  if (!zoneId || !/^[a-f0-9]{32}$/.test(zoneId) || !zoneName || !/^[a-z0-9.-]+$/.test(zoneName) || !scriptName || !/^[a-z0-9_-]+$/.test(scriptName)) throw new Error("Real mode requires valid CF_ZONE_ID, CF_ZONE_NAME, and SINKHOLE_SCRIPT_NAME");
  if (!env.CF_API_TOKEN) throw new Error("CF_API_TOKEN is missing");
  return { zoneId, zoneName, scriptName };
}

export class RealClient implements CloudflareClient {
  private readonly base = "https://api.cloudflare.com/client/v4";
  private readonly config: ReturnType<typeof realConfig>;
  private checks = 0;
  constructor(private readonly env: AppEnv, private readonly fetcher: typeof fetch = fetch) { this.config = realConfig(env); }
  private assertMutable(): void { if (String(this.env.DRY_RUN) !== "false") throw new Error("DRY_RUN blocks Cloudflare writes"); }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.env.CF_API_TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 404) throw new Error("Cloudflare resource not found (404)");
    const envelope = await response.json() as ApiEnvelope<T>;
    if (!response.ok || !envelope.success) {
      const code = envelope.errors?.[0]?.code;
      throw new Error(`Cloudflare API ${method} failed (${response.status}${code ? `, ${code}` : ""})`);
    }
    return envelope.result;
  }

  async listRecords(zoneId: string): Promise<DnsRecord[]> {
    if (zoneId !== this.config.zoneId) throw new Error("Zone mismatch");
    const all: DnsRecord[] = [];
    for (let page = 1; page <= 20; page++) {
      const result = await this.call<RawRecord[]>("GET", `/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
      all.push(...result.map(toDnsRecord));
      if (result.length < 100) return all;
    }
    throw new Error("Zone exceeds the 2,000-record read limit; narrow the scope before scoring");
  }
  async getZoneName(): Promise<string> {
    const zone = await this.call<{ name: string }>("GET", `/zones/${this.config.zoneId}`);
    return zone.name.toLowerCase().replace(/\.$/, "");
  }

  async getRecord(recordId: string): Promise<DnsRecord | null> {
    if (!/^[a-f0-9]{32}$/.test(recordId)) return null;
    try { return toDnsRecord(await this.call<RawRecord>("GET", `/zones/${this.config.zoneId}/dns_records/${recordId}`)); }
    catch (error) { if (error instanceof Error && error.message.includes("(404)")) return null; throw error; }
  }

  async targetResolves(record: DnsRecord): Promise<boolean | null> {
    if (record.type !== "CNAME" || this.checks++ >= 25) return null;
    try {
      const name = record.content.replace(/\.$/, "");
      const response = await this.fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`, { headers: { accept: "application/dns-json" } });
      if (!response.ok) return null;
      const result = await response.json() as { Status?: number; Answer?: { type?: number }[] };
      return result.Status === 3 ? false : result.Status === 0 && result.Answer?.some((answer) => answer.type === 1 || answer.type === 28) ? true : null;
    } catch { return null; }
  }

  async recentTraffic(_record: DnsRecord): Promise<number | null> { return null; }

  async zoneFetch(path: string, body?: unknown): Promise<Response> {
    const stub = this.env.RealZone.get(this.env.RealZone.idFromName(this.config.zoneId));
    return stub.fetch(new Request(`https://real-zone.internal${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) }));
  }

  async listRoutes(): Promise<RawRoute[]> { return this.call<RawRoute[]>("GET", `/zones/${this.config.zoneId}/workers/routes`); }
  async createRoute(pattern: string): Promise<RawRoute> { this.assertMutable(); return this.call<RawRoute>("POST", `/zones/${this.config.zoneId}/workers/routes`, { pattern, script: this.config.scriptName }); }
  async deleteRoute(routeId: string): Promise<void> { this.assertMutable(); await this.call<unknown>("DELETE", `/zones/${this.config.zoneId}/workers/routes/${routeId}`); }

  async quarantineRecord(record: DnsRecord): Promise<DnsRecord> {
    this.assertMutable();
    const content = record.type === "A" ? "192.0.2.0" : record.type === "AAAA" ? "100::" : "sinkhole.invalid";
    return toDnsRecord(await this.call<RawRecord>("PATCH", `/zones/${this.config.zoneId}/dns_records/${record.id}`, { content, proxied: true, ttl: 1 }));
  }

  async restoreRecord(record: DnsRecord): Promise<DnsRecord> {
    this.assertMutable();
    return toDnsRecord(await this.call<RawRecord>("PATCH", `/zones/${this.config.zoneId}/dns_records/${record.id}`, { content: record.content, proxied: record.proxied, ttl: record.ttl, ...(record.raw?.comment !== undefined ? { comment: record.raw.comment } : {}), ...(record.raw?.tags !== undefined ? { tags: record.raw.tags } : {}), ...(record.raw?.settings !== undefined ? { settings: record.raw.settings } : {}) }));
  }

  async recreateRecord(record: DnsRecord): Promise<DnsRecord> {
    this.assertMutable();
    const raw = record.raw;
    return toDnsRecord(await this.call<RawRecord>("POST", `/zones/${this.config.zoneId}/dns_records`, { type: record.type, name: record.name, content: record.content, proxied: record.proxied, ttl: record.ttl, ...(raw?.comment !== undefined ? { comment: raw.comment } : {}), ...(raw?.tags !== undefined ? { tags: raw.tags } : {}), ...(raw?.settings !== undefined ? { settings: raw.settings } : {}) }));
  }

  async deleteRecord(recordId: string): Promise<void> { this.assertMutable(); await this.call<unknown>("DELETE", `/zones/${this.config.zoneId}/dns_records/${recordId}`); }
}

export function toDnsRecord(raw: RawRecord): DnsRecord {
  if (!raw || !raw.id || !raw.zone_id || !raw.name || !raw.type || typeof raw.content !== "string") throw new Error("Cloudflare returned an incomplete DNS record");
  return { id: raw.id, zoneId: raw.zone_id, name: raw.name, type: raw.type as DnsRecord["type"], content: raw.content, createdOn: raw.created_on, modifiedOn: raw.modified_on, proxied: Boolean(raw.proxied), ttl: raw.ttl, raw: { comment: raw.comment, tags: raw.tags, settings: raw.settings } };
}
