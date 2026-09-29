import { DurableObject } from "cloudflare:workers";
import { RealClient, realConfig } from "./clients/real";
import type { AppEnv } from "./env";
import { isEligible } from "./scoring";
import type { DnsRecord } from "./types";

type State = "starting" | "quarantined" | "resurrected" | "deleted" | "cancelled";
type Row = { record_id: string; state: State; snapshot_json: string; workflow_id: string; route_pattern: string; route_id: string | null; started_at: string | null; restored_id: string | null };
const placeholder = (record: DnsRecord): string => record.type === "A" ? "192.0.2.0" : record.type === "AAAA" ? "100::" : "sinkhole.invalid";
const mutableMatch = (a: DnsRecord, b: DnsRecord): boolean => a.id === b.id && a.zoneId === b.zoneId && a.name === b.name && a.type === b.type && a.content === b.content && a.proxied === b.proxied && a.ttl === b.ttl && a.modifiedOn === b.modifiedOn;
const isPlaceholder = (current: DnsRecord, snapshot: DnsRecord): boolean => current.id === snapshot.id && current.name === snapshot.name && current.type === snapshot.type && current.content === placeholder(snapshot) && current.proxied && current.ttl === 1 && JSON.stringify(current.raw) === JSON.stringify(snapshot.raw);
const hash = async (value: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const validWindow = (seconds: unknown, threshold: unknown): seconds is number => Number.isInteger(seconds) && Number(seconds) >= 3600 && Number(seconds) <= 14 * 86400 && Number.isInteger(threshold) && Number(threshold) >= 1 && Number(threshold) <= 10;
export const routeOverlaps = (hostname: string, pattern: string): boolean => {
  const hostPattern = pattern.toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  return hostPattern === hostname.toLowerCase() || hostPattern.startsWith("*") && hostname.toLowerCase().endsWith(hostPattern.slice(1));
};

export class RealZone extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS confirmations (token_hash TEXT PRIMARY KEY, record_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, expires_at INTEGER NOT NULL, seconds INTEGER NOT NULL, threshold INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS quarantines (record_id TEXT PRIMARY KEY, state TEXT NOT NULL, snapshot_json TEXT NOT NULL, workflow_id TEXT NOT NULL, route_pattern TEXT NOT NULL, route_id TEXT, started_at TEXT, restored_id TEXT);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    const config = realConfig(this.env);
    const client = new RealClient(this.env);
    if (request.method === "GET" && url.pathname === "/quarantines") return Response.json({ active: [...sql.exec<{ record_id: string; state: State }>("SELECT record_id, state FROM quarantines WHERE state IN ('starting', 'quarantined')")].map((row) => ({ recordId: row.record_id, state: row.state })) });
    if (request.method === "GET" && url.pathname === "/graveyard") return Response.json({ recordIds: [...sql.exec<{ record_id: string }>("SELECT record_id FROM quarantines WHERE state = 'deleted' ORDER BY started_at DESC LIMIT 40")].map((row) => row.record_id) });
    if (request.method === "GET" && url.pathname.startsWith("/quarantine/")) {
      const row = this.row(url.pathname.slice("/quarantine/".length));
      return row ? Response.json({ recordId: row.record_id, state: row.state, workflowId: row.workflow_id, routePattern: row.route_pattern, routeId: row.route_id, restoredId: row.restored_id }) : Response.json({ error: "Not found" }, { status: 404 });
    }
    if (request.method === "GET" && url.pathname.startsWith("/route/")) {
      const host = url.pathname.slice("/route/".length).toLowerCase();
      const row = [...sql.exec<{ record_id: string }>("SELECT record_id FROM quarantines WHERE route_pattern = ? AND state = 'quarantined'", `${host}/*`)][0];
      return row ? Response.json({ recordId: row.record_id }) : Response.json({ error: "Not found" }, { status: 404 });
    }
    if (request.method !== "POST") return Response.json({ error: "Not found" }, { status: 404 });
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const recordId = body.recordId;
    if (typeof recordId !== "string" || !/^[a-f0-9]{32}$/.test(recordId)) return Response.json({ error: "Invalid record ID" }, { status: 400 });
    const protectedNames = this.env.PROTECTED_NAMES.split(",").map((name) => name.trim());

    if (url.pathname === "/propose") {
      if (!validWindow(body.quarantineSeconds, body.screamThreshold)) return Response.json({ error: "Real quarantine must last 1 hour to 14 days; threshold must be 1 to 10" }, { status: 400 });
      if (await client.getZoneName() !== config.zoneName) return Response.json({ error: "CF_ZONE_NAME does not match the Cloudflare zone" }, { status: 409 });
      if (this.activeCount() >= 3) return Response.json({ error: "Three quarantines are already active" }, { status: 409 });
      const record = await client.getRecord(recordId);
      if (!record || !isEligible(record, config.zoneName, protectedNames) || record.proxied) return Response.json({ error: "Only eligible, unproxied records can be quarantined" }, { status: 403 });
      if ((await client.listRoutes()).some((route) => routeOverlaps(record.name, route.pattern))) return Response.json({ error: "A Worker route already owns this hostname" }, { status: 409 });
      const token = crypto.randomUUID() + crypto.randomUUID();
      const expiresAt = Date.now() + 5 * 60_000;
      sql.exec("DELETE FROM confirmations WHERE expires_at < ?", Date.now());
      sql.exec("INSERT INTO confirmations (token_hash, record_id, snapshot_json, expires_at, seconds, threshold) VALUES (?, ?, ?, ?, ?, ?)", await hash(token), recordId, JSON.stringify(record), expiresAt, body.quarantineSeconds, body.screamThreshold);
      return Response.json({ token, expiresAt: new Date(expiresAt).toISOString(), record, quarantineSeconds: body.quarantineSeconds, screamThreshold: body.screamThreshold });
    }

    if (url.pathname === "/confirm") {
      if (typeof body.token !== "string" || typeof body.workflowId !== "string" || !validWindow(body.quarantineSeconds, body.screamThreshold)) return Response.json({ error: "Invalid confirmation" }, { status: 400 });
      if (await client.getZoneName() !== config.zoneName) return Response.json({ error: "CF_ZONE_NAME does not match the Cloudflare zone" }, { status: 409 });
      const tokenHash = await hash(body.token);
      const token = [...sql.exec<{ record_id: string; snapshot_json: string; expires_at: number; seconds: number; threshold: number }>("SELECT * FROM confirmations WHERE token_hash = ?", tokenHash)][0];
      if (!token || token.record_id !== recordId || token.expires_at < Date.now() || token.seconds !== body.quarantineSeconds || token.threshold !== body.screamThreshold) return Response.json({ error: "Confirmation expired, used, or changed" }, { status: 409 });
      const snapshot = JSON.parse(token.snapshot_json) as DnsRecord;
      const current = await client.getRecord(recordId);
      if (!current || !mutableMatch(current, snapshot) || !isEligible(current, config.zoneName, protectedNames) || current.proxied) return Response.json({ error: "Record changed since proposal" }, { status: 409 });
      if ((await client.listRoutes()).some((route) => routeOverlaps(snapshot.name, route.pattern))) return Response.json({ error: "A Worker route now owns this hostname" }, { status: 409 });
      return this.ctx.storage.transactionSync(() => {
        const fresh = [...sql.exec<{ token_hash: string }>("SELECT token_hash FROM confirmations WHERE token_hash = ?", tokenHash)][0];
        if (!fresh || this.activeCount() >= 3) return Response.json({ error: "Confirmation used or quarantine limit reached" }, { status: 409 });
        if (String(this.env.DRY_RUN) !== "false") return Response.json({ record: snapshot, routePattern: `${snapshot.name}/*`, dryRun: true });
        sql.exec("DELETE FROM confirmations WHERE token_hash = ?", tokenHash);
        sql.exec("INSERT INTO quarantines (record_id, state, snapshot_json, workflow_id, route_pattern) VALUES (?, 'starting', ?, ?, ?) ON CONFLICT(record_id) DO UPDATE SET state='starting', snapshot_json=excluded.snapshot_json, workflow_id=excluded.workflow_id, route_pattern=excluded.route_pattern, route_id=NULL, started_at=NULL, restored_id=NULL", recordId, token.snapshot_json, body.workflowId, `${snapshot.name}/*`);
        return Response.json({ record: snapshot, routePattern: `${snapshot.name}/*`, workflowId: body.workflowId });
      });
    }

    if (url.pathname === "/cancel") {
      const row = this.row(recordId);
      if (row?.state === "starting" && !row.route_id) sql.exec("UPDATE quarantines SET state = 'cancelled' WHERE record_id = ?", recordId);
      return Response.json({ state: this.row(recordId)?.state ?? "cancelled" });
    }
    if (String(this.env.DRY_RUN) !== "false") return Response.json({ error: "DRY_RUN is enabled" }, { status: 403 });
    const row = this.row(recordId);
    if (!row) return Response.json({ error: "No reservation" }, { status: 404 });
    const snapshot = JSON.parse(row.snapshot_json) as DnsRecord;

    if (url.pathname === "/apply") {
      if (row.state === "quarantined") return Response.json({ state: row.state, startedAt: row.started_at, routePattern: row.route_pattern });
      if (row.state !== "starting") return Response.json({ error: "Not starting" }, { status: 409 });
      let routeId = row.route_id;
      if (!routeId) {
        if ((await client.listRoutes()).some((route) => routeOverlaps(snapshot.name, route.pattern))) return Response.json({ error: "Route conflict; manual inspection required" }, { status: 409 });
        const route = await client.createRoute(row.route_pattern);
        routeId = route.id;
        sql.exec("UPDATE quarantines SET route_id = ? WHERE record_id = ?", routeId, recordId);
      }
      const attached = (await client.listRoutes()).find((route) => route.id === routeId);
      if (!attached || attached.pattern !== row.route_pattern || attached.script !== config.scriptName) return Response.json({ error: "Sinkhole route is not attached to this Worker" }, { status: 409 });
      const current = await client.getRecord(recordId);
      if (!current) return Response.json({ error: "Original record disappeared" }, { status: 409 });
      if (!isPlaceholder(current, snapshot)) {
        if (!mutableMatch(current, snapshot)) return Response.json({ error: "Record changed; restore manually" }, { status: 409 });
        await client.quarantineRecord(snapshot);
      }
      const startedAt = new Date().toISOString();
      sql.exec("UPDATE quarantines SET state = 'quarantined', started_at = ? WHERE record_id = ?", startedAt, recordId);
      return Response.json({ state: "quarantined", startedAt, routePattern: row.route_pattern });
    }

    if (url.pathname === "/restore") {
      if (row.state === "resurrected") return Response.json({ state: row.state, restoredId: row.restored_id });
      if (!["starting", "quarantined", "deleted"].includes(row.state)) return Response.json({ error: "Cannot restore this state" }, { status: 409 });
      let restoredId: string | null = row.restored_id;
      if (row.state === "deleted") {
        if (!restoredId) {
          const matches = (await client.listRecords(config.zoneId)).filter((record) => record.name === snapshot.name && record.type === snapshot.type);
          if (matches.some((record) => record.content !== snapshot.content || record.proxied !== snapshot.proxied)) return Response.json({ error: "Name now has a conflicting record" }, { status: 409 });
          const restored = matches.find((record) => record.content === snapshot.content && record.proxied === snapshot.proxied) ?? await client.recreateRecord(snapshot);
          restoredId = restored.id;
          sql.exec("UPDATE quarantines SET restored_id = ? WHERE record_id = ?", restoredId, recordId);
        }
      } else {
        const current = await client.getRecord(recordId);
        if (current && isPlaceholder(current, snapshot)) await client.restoreRecord(snapshot);
        else if (current && !mutableMatch(current, snapshot)) return Response.json({ error: "Record changed; restore manually" }, { status: 409 });
        else if (!current) return Response.json({ error: "Original record disappeared" }, { status: 409 });
        restoredId = recordId;
      }
      if (row.route_id) {
        const route = (await client.listRoutes()).find((item) => item.id === row.route_id);
        if (route && (route.pattern !== row.route_pattern || route.script !== config.scriptName)) return Response.json({ error: "Route ownership changed; manual inspection required" }, { status: 409 });
        try { await client.deleteRoute(row.route_id); }
        catch (error) { if (!(error instanceof Error && error.message.includes("(404)"))) throw error; }
      }
      sql.exec("UPDATE quarantines SET state = 'resurrected', restored_id = ? WHERE record_id = ?", restoredId, recordId);
      return Response.json({ state: "resurrected", restoredId });
    }

    if (url.pathname === "/delete") {
      if (row.state === "deleted") return Response.json({ state: "deleted" });
      if (row.state !== "quarantined") return Response.json({ error: "Not quarantined" }, { status: 409 });
      const current = await client.getRecord(recordId);
      if (current && !isPlaceholder(current, snapshot)) return Response.json({ error: "Record changed; deletion stopped" }, { status: 409 });
      if (current) await client.deleteRecord(recordId);
      if (row.route_id) {
        const route = (await client.listRoutes()).find((item) => item.id === row.route_id);
        if (route && (route.pattern !== row.route_pattern || route.script !== config.scriptName)) return Response.json({ error: "Route ownership changed; manual inspection required" }, { status: 409 });
        try { await client.deleteRoute(row.route_id); }
        catch (error) { if (!(error instanceof Error && error.message.includes("(404)"))) throw error; }
      }
      sql.exec("UPDATE quarantines SET state = 'deleted' WHERE record_id = ?", recordId);
      return Response.json({ state: "deleted" });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private row(recordId: string): Row | undefined { return [...this.ctx.storage.sql.exec<Row>("SELECT * FROM quarantines WHERE record_id = ?", recordId)][0]; }
  private activeCount(): number { return [...this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM quarantines WHERE state IN ('starting', 'quarantined')")][0].count; }
}
