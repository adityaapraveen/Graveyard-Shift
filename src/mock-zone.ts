import { DurableObject } from "cloudflare:workers";
import { createMockRecords } from "./clients/mock";
import type { AppEnv } from "./env";
import { isEligible } from "./scoring";
import type { DnsRecord } from "./types";

type QuarantineState = "starting" | "quarantined" | "resurrected" | "deleted" | "cancelled";
type QuarantineRow = Record<string, string | null> & { record_id: string; state: QuarantineState; snapshot_json: string; route_pattern: string; workflow_id: string; started_at: string | null };

export class MockZone extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, record_json TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS confirmations (
        token_hash TEXT PRIMARY KEY, record_id TEXT NOT NULL, record_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL, seconds INTEGER NOT NULL, threshold INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quarantines (
        record_id TEXT PRIMARY KEY, state TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        route_pattern TEXT NOT NULL, workflow_id TEXT NOT NULL, started_at TEXT
      );
      CREATE TABLE IF NOT EXISTS routes (pattern TEXT PRIMARY KEY, record_id TEXT NOT NULL);
    `);
    const columns = [...sql.exec<{ name: string }>("PRAGMA table_info(quarantines)")].map((row) => row.name);
    if (!columns.includes("started_at")) sql.exec("ALTER TABLE quarantines ADD COLUMN started_at TEXT");
    if (![...sql.exec("SELECT id FROM records LIMIT 1")].length) {
      for (const record of createMockRecords()) sql.exec("INSERT INTO records (id, record_json, state) VALUES (?, ?, 'active')", record.id, JSON.stringify(record));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    if (request.method === "GET" && url.pathname === "/records") {
      return Response.json([...sql.exec<{ record_json: string }>("SELECT record_json FROM records WHERE state != 'deleted'")].map((row) => JSON.parse(row.record_json)));
    }
    if (request.method === "GET" && url.pathname.startsWith("/quarantine/")) {
      const id = url.pathname.slice("/quarantine/".length);
      const row = this.quarantine(id);
      return row ? Response.json({ recordId: id, state: row.state, workflowId: row.workflow_id, routePattern: row.route_pattern }) : Response.json({ error: "Not found" }, { status: 404 });
    }
    if (request.method === "GET" && url.pathname.startsWith("/route/")) {
      const pattern = `${url.pathname.slice("/route/".length)}/*`;
      const route = [...sql.exec<{ record_id: string }>("SELECT record_id FROM routes WHERE pattern = ?", pattern)][0];
      return route ? Response.json({ recordId: route.record_id }) : Response.json({ error: "Route not found" }, { status: 404 });
    }
    if (request.method !== "POST") return Response.json({ error: "Not found" }, { status: 404 });
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const recordId = body.recordId;
    if (typeof recordId !== "string") return Response.json({ error: "Invalid record ID" }, { status: 400 });

    if (url.pathname === "/propose") {
      if (!validWindow(body.quarantineSeconds, body.screamThreshold)) return Response.json({ error: "Invalid quarantine window or threshold" }, { status: 400 });
      const record = this.activeRecord(recordId);
      if (!record || !this.eligible(record)) return Response.json({ error: "Record is not eligible" }, { status: 403 });
      if (this.activeCount() >= 3) return Response.json({ error: "Three quarantines are already active" }, { status: 409 });
      const token = crypto.randomUUID() + crypto.randomUUID();
      const tokenHash = await sha256(token);
      const expiresAt = Date.now() + 5 * 60_000;
      sql.exec("DELETE FROM confirmations WHERE expires_at < ?", Date.now());
      sql.exec("INSERT INTO confirmations (token_hash, record_id, record_json, expires_at, seconds, threshold) VALUES (?, ?, ?, ?, ?, ?)", tokenHash, recordId, JSON.stringify(record), expiresAt, body.quarantineSeconds, body.screamThreshold);
      return Response.json({ token, expiresAt: new Date(expiresAt).toISOString(), record, quarantineSeconds: body.quarantineSeconds, screamThreshold: body.screamThreshold });
    }

    if (url.pathname === "/confirm") {
      if (typeof body.token !== "string" || typeof body.workflowId !== "string") return Response.json({ error: "Invalid confirmation" }, { status: 400 });
      const hash = await sha256(body.token);
      return this.ctx.storage.transactionSync(() => {
        const token = [...sql.exec<{ record_id: string; record_json: string; expires_at: number; seconds: number; threshold: number }>("SELECT record_id, record_json, expires_at, seconds, threshold FROM confirmations WHERE token_hash = ?", hash)][0];
        const record = this.activeRecord(recordId);
        if (!token || token.record_id !== recordId || token.expires_at < Date.now() || !record || !this.eligible(record) || token.record_json !== JSON.stringify(record) || token.seconds !== body.quarantineSeconds || token.threshold !== body.screamThreshold) {
          return Response.json({ error: "Confirmation expired, used, or record changed" }, { status: 409 });
        }
        if (this.activeCount() >= 3) return Response.json({ error: "Three quarantines are already active" }, { status: 409 });
        const pattern = `${record.name}/*`;
        if (String(this.env.DRY_RUN) !== "false") return Response.json({ record, routePattern: pattern, dryRun: true });
        sql.exec("DELETE FROM confirmations WHERE token_hash = ?", hash);
        sql.exec("INSERT INTO quarantines (record_id, state, snapshot_json, route_pattern, workflow_id, started_at) VALUES (?, 'starting', ?, ?, ?, NULL) ON CONFLICT(record_id) DO UPDATE SET state='starting', snapshot_json=excluded.snapshot_json, route_pattern=excluded.route_pattern, workflow_id=excluded.workflow_id, started_at=NULL", recordId, JSON.stringify(record), pattern, body.workflowId);
        return Response.json({ record, routePattern: pattern, workflowId: body.workflowId });
      });
    }

    if (url.pathname === "/apply") {
      this.requireMutable();
      const row = this.quarantine(recordId);
      if (!row || !["starting", "quarantined"].includes(row.state)) return Response.json({ error: "No active reservation" }, { status: 409 });
      if (row.state === "starting") {
        const record = JSON.parse(row.snapshot_json) as DnsRecord;
        const quarantineRecord = { ...record, content: "192.0.2.254", proxied: true };
        sql.exec("UPDATE records SET record_json = ?, state = 'quarantined' WHERE id = ?", JSON.stringify(quarantineRecord), recordId);
        sql.exec("INSERT OR REPLACE INTO routes (pattern, record_id) VALUES (?, ?)", row.route_pattern, recordId);
        sql.exec("UPDATE quarantines SET state = 'quarantined', started_at = ? WHERE record_id = ?", new Date().toISOString(), recordId);
      }
      return Response.json({ state: "quarantined", routePattern: row.route_pattern, startedAt: this.quarantine(recordId)?.started_at });
    }

    if (url.pathname === "/restore") {
      this.requireMutable();
      const row = this.quarantine(recordId);
      if (!row) return Response.json({ error: "No quarantine" }, { status: 404 });
      if (row.state === "resurrected") return Response.json({ state: "resurrected" });
      if (!["starting", "quarantined", "deleted"].includes(row.state)) return Response.json({ error: "Cannot restore this state" }, { status: 409 });
      sql.exec("UPDATE records SET record_json = ?, state = 'active' WHERE id = ?", row.snapshot_json, recordId);
      sql.exec("DELETE FROM routes WHERE pattern = ?", row.route_pattern);
      sql.exec("UPDATE quarantines SET state = 'resurrected' WHERE record_id = ?", recordId);
      return Response.json({ state: "resurrected" });
    }

    if (url.pathname === "/delete") {
      this.requireMutable();
      const row = this.quarantine(recordId);
      if (!row) return Response.json({ error: "No quarantine" }, { status: 404 });
      if (row.state === "deleted") return Response.json({ state: "deleted" });
      if (row.state !== "quarantined") return Response.json({ error: "Cannot delete this state" }, { status: 409 });
      sql.exec("UPDATE records SET state = 'deleted' WHERE id = ?", recordId);
      sql.exec("DELETE FROM routes WHERE pattern = ?", row.route_pattern);
      sql.exec("UPDATE quarantines SET state = 'deleted' WHERE record_id = ?", recordId);
      return Response.json({ state: "deleted" });
    }

    if (url.pathname === "/cancel") {
      const row = this.quarantine(recordId);
      if (row?.state === "starting") sql.exec("UPDATE quarantines SET state = 'cancelled' WHERE record_id = ?", recordId);
      return Response.json({ state: "cancelled" });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private activeRecord(id: string): DnsRecord | null {
    const row = [...this.ctx.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM records WHERE id = ? AND state = 'active'", id)][0];
    return row ? JSON.parse(row.record_json) as DnsRecord : null;
  }

  private quarantine(id: string): QuarantineRow | undefined {
    return [...this.ctx.storage.sql.exec<QuarantineRow>("SELECT * FROM quarantines WHERE record_id = ?", id)][0];
  }

  private activeCount(): number {
    return [...this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM quarantines WHERE state IN ('starting', 'quarantined')")][0].count;
  }

  private eligible(record: DnsRecord): boolean {
    return isEligible(record, "example.test", this.env.PROTECTED_NAMES.split(",").map((name) => name.trim()));
  }

  private requireMutable(): void {
    if (String(this.env.DRY_RUN) !== "false") throw new Error("DRY_RUN is enabled");
  }
}

function validWindow(seconds: unknown, threshold: unknown): seconds is number {
  return Number.isInteger(seconds) && Number(seconds) >= 1 && Number(seconds) <= 120 &&
    Number.isInteger(threshold) && Number(threshold) >= 1 && Number(threshold) <= 10;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
