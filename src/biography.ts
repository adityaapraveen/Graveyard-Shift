import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import type { DnsRecord, Signal, Suspect } from "./types";

export interface Biography {
  record: DnsRecord;
  snapshot: DnsRecord;
  score: number;
  signals: Signal[];
  state: "suspect" | "quarantined" | "resurrected" | "deleted";
  events: { at: string; kind: string; detail: string }[];
  hits: { at: string; ipHash: string; userAgent: string; path: string; country: string; counted: boolean; reason: string; workflowId: string }[];
  quarantine: { workflowId: string; deadlineAt: string; threshold: number; resurrectRequested: boolean } | null;
}

export class ResourceBiography extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS biography (
        id INTEGER PRIMARY KEY CHECK (id = 1), record_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL, score INTEGER NOT NULL,
        signals_json TEXT NOT NULL, state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
        kind TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sinkhole_hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
        ip_hash TEXT NOT NULL, user_agent TEXT NOT NULL,
        path TEXT NOT NULL, country TEXT NOT NULL,
        counted INTEGER NOT NULL DEFAULT 1, reason TEXT NOT NULL DEFAULT 'unique',
        workflow_id TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS quarantine_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1), workflow_id TEXT NOT NULL,
        deadline_at TEXT NOT NULL, threshold INTEGER NOT NULL,
        resurrect_requested INTEGER NOT NULL DEFAULT 0
      );
    `);
    const columns = [...ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(sinkhole_hits)")].map((row) => row.name);
    if (!columns.includes("counted")) ctx.storage.sql.exec("ALTER TABLE sinkhole_hits ADD COLUMN counted INTEGER NOT NULL DEFAULT 1");
    if (!columns.includes("reason")) ctx.storage.sql.exec("ALTER TABLE sinkhole_hits ADD COLUMN reason TEXT NOT NULL DEFAULT 'unique'");
    if (!columns.includes("workflow_id")) ctx.storage.sql.exec("ALTER TABLE sinkhole_hits ADD COLUMN workflow_id TEXT NOT NULL DEFAULT ''");
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/sync" && request.method === "POST") {
      const suspect = await request.json() as Suspect;
      if (!isSuspect(suspect)) return Response.json({ error: "Invalid suspect" }, { status: 400 });
      const sql = this.ctx.storage.sql;
      const previous = [...sql.exec<{ record_json: string; state: string }>("SELECT record_json, state FROM biography WHERE id = 1")][0];
      if (previous && JSON.parse(previous.record_json).id !== suspect.record.id) return Response.json({ error: "Record identity mismatch" }, { status: 409 });
      if (previous?.state === "quarantined" || previous?.state === "deleted") return Response.json({ error: "Biography is not in suspect state" }, { status: 409 });
      const recordJson = JSON.stringify(suspect.record);
      sql.exec(
        `INSERT INTO biography (id, record_json, snapshot_json, score, signals_json, state)
         VALUES (1, ?, ?, ?, ?, 'suspect')
         ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,
         score=excluded.score, signals_json=excluded.signals_json`,
        recordJson, recordJson, suspect.score, JSON.stringify(suspect.signals)
      );
      if (!previous) sql.exec("INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)", new Date().toISOString(), "observed", `First observed ${suspect.record.name}; creation timestamp is from DNS metadata.`);
      else if (previous.record_json !== recordJson) sql.exec("INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)", new Date().toISOString(), "modified", "DNS metadata changed since last observation.");
      return Response.json(this.readBiography());
    }
    if (path === "/" && request.method === "GET") {
      const biography = this.readBiography();
      return biography ? Response.json(biography) : Response.json({ error: "Biography not found" }, { status: 404 });
    }
    if (request.method === "POST" && ["/snapshot", "/quarantined", "/hit", "/resurrect-request", "/resurrected", "/deleted"].includes(path)) {
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
      const sql = this.ctx.storage.sql;
      const biography = this.readBiography();
      if (!biography) return Response.json({ error: "Biography not found" }, { status: 404 });
      if (path === "/snapshot") {
        if (typeof body.workflowId !== "string" || typeof body.deadlineAt !== "string" || typeof body.threshold !== "number" || !body.snapshot || typeof body.snapshot !== "object") return Response.json({ error: "Invalid snapshot" }, { status: 400 });
        const snapshot = body.snapshot as DnsRecord;
        if (snapshot.id !== biography.record.id || snapshot.zoneId !== biography.record.zoneId) return Response.json({ error: "Snapshot identity mismatch" }, { status: 409 });
        const current = biography.quarantine;
        if (current?.workflowId === body.workflowId) return Response.json(biography);
        if (!["suspect", "resurrected"].includes(biography.state)) return Response.json({ error: "Cannot snapshot this state" }, { status: 409 });
        sql.exec("UPDATE biography SET record_json = ?, snapshot_json = ?, state = 'suspect' WHERE id = 1", JSON.stringify(snapshot), JSON.stringify(snapshot));
        sql.exec("INSERT INTO quarantine_meta (id, workflow_id, deadline_at, threshold, resurrect_requested) VALUES (1, ?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET workflow_id=excluded.workflow_id, deadline_at=excluded.deadline_at, threshold=excluded.threshold, resurrect_requested=0", body.workflowId, body.deadlineAt, body.threshold);
        this.event("snapshot", "Full record saved before quarantine.");
        return Response.json(this.readBiography());
      }
      if (path === "/quarantined") {
        if (biography.state === "quarantined") return Response.json(biography);
        if (biography.state !== "suspect" || !biography.quarantine || typeof body.deadlineAt !== "string" || !Number.isFinite(Date.parse(body.deadlineAt))) return Response.json({ error: "No snapshot or deadline for quarantine" }, { status: 409 });
        sql.exec("UPDATE quarantine_meta SET deadline_at = ? WHERE id = 1", body.deadlineAt);
        sql.exec("UPDATE biography SET state = 'quarantined' WHERE id = 1");
        this.event("quarantined", "Record proxied to the sinkhole route.");
        return Response.json(this.readBiography());
      }
      if (path === "/hit") {
        if (biography.state !== "quarantined") return Response.json({ error: "Not quarantined" }, { status: 409 });
        const { ipHash, userAgent, hitPath, country } = body;
        if (typeof ipHash !== "string" || typeof userAgent !== "string" || typeof hitPath !== "string" || typeof country !== "string") return Response.json({ error: "Invalid hit" }, { status: 400 });
        if (!biography.quarantine) return Response.json({ error: "Quarantine metadata missing" }, { status: 409 });
        const workflowId = biography.quarantine.workflowId;
        const bot = /bot|spider|crawler|curl|wget|monitor|healthcheck/i.test(userAgent);
        const normalizedUa = userAgent.slice(0, 256);
        const prior = [...sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sinkhole_hits WHERE workflow_id = ? AND ip_hash = ? AND user_agent = ? AND counted = 1", workflowId, ipHash, normalizedUa)][0].count;
        const counted = !bot && prior === 0;
        sql.exec("INSERT INTO sinkhole_hits (at, ip_hash, user_agent, path, country, counted, reason, workflow_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", new Date().toISOString(), ipHash, normalizedUa, hitPath.slice(0, 512), country.slice(0, 64), counted ? 1 : 0, bot ? "bot" : prior ? "duplicate" : "unique", workflowId);
        const uniqueHits = [...sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sinkhole_hits WHERE workflow_id = ? AND counted = 1", workflowId)][0].count;
        const alreadyScreamed = [...sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events WHERE kind = 'screamed' AND id > COALESCE((SELECT MAX(id) FROM events WHERE kind = 'snapshot'), 0)")][0].count > 0;
        if (counted && !alreadyScreamed && biography.quarantine && uniqueHits >= biography.quarantine.threshold) this.event("screamed", `Scream threshold reached at ${uniqueHits} unique hits.`);
        return Response.json({ counted, uniqueHits });
      }
      if (path === "/resurrect-request") {
        if (biography.state !== "quarantined") return Response.json({ error: "Not quarantined" }, { status: 409 });
        if (!biography.quarantine?.resurrectRequested) {
          sql.exec("UPDATE quarantine_meta SET resurrect_requested = 1 WHERE id = 1");
          this.event("resurrect-requested", "Administrator requested restoration.");
        }
        return Response.json(this.readBiography());
      }
      if (path === "/resurrected") {
        if (biography.state === "resurrected") return Response.json(biography);
        if (!["quarantined", "suspect", "deleted"].includes(biography.state)) return Response.json({ error: "Cannot resurrect this state" }, { status: 409 });
        sql.exec("UPDATE biography SET state = 'resurrected', record_json = snapshot_json WHERE id = 1");
        this.event("resurrected", "Original DNS record restored from snapshot; sinkhole route removed.");
        return Response.json(this.readBiography());
      }
      if (path === "/deleted") {
        if (biography.state === "deleted") return Response.json(biography);
        if (biography.state !== "quarantined") return Response.json({ error: "Cannot delete this state" }, { status: 409 });
        sql.exec("UPDATE biography SET state = 'deleted' WHERE id = 1");
        this.event("deleted", "Quarantine window ended without reaching the scream threshold; original snapshot retained.");
        return Response.json(this.readBiography());
      }
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private readBiography(): Biography | null {
    const sql = this.ctx.storage.sql;
    const row = [...sql.exec<{ record_json: string; snapshot_json: string; score: number; signals_json: string; state: Biography["state"] }>("SELECT * FROM biography WHERE id = 1")][0];
    if (!row) return null;
    return {
      record: JSON.parse(row.record_json) as DnsRecord,
      snapshot: JSON.parse(row.snapshot_json) as DnsRecord,
      score: row.score,
      signals: JSON.parse(row.signals_json) as Signal[],
      state: row.state,
      events: [...sql.exec<{ at: string; kind: string; detail: string }>("SELECT at, kind, detail FROM events ORDER BY id")],
      hits: [...sql.exec<{ at: string; ipHash: string; userAgent: string; path: string; country: string; counted: number; reason: string; workflowId: string }>("SELECT at, ip_hash AS ipHash, user_agent AS userAgent, path, country, counted, reason, workflow_id AS workflowId FROM sinkhole_hits ORDER BY id")].map((hit) => ({ ...hit, counted: hit.counted === 1 })),
      quarantine: (() => {
        const meta = [...sql.exec<{ workflow_id: string; deadline_at: string; threshold: number; resurrect_requested: number }>("SELECT * FROM quarantine_meta WHERE id = 1")][0];
        return meta ? { workflowId: meta.workflow_id, deadlineAt: meta.deadline_at, threshold: meta.threshold, resurrectRequested: meta.resurrect_requested === 1 } : null;
      })()
    };
  }

  private event(kind: string, detail: string): void {
    this.ctx.storage.sql.exec("INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)", new Date().toISOString(), kind, detail);
  }
}

function isSuspect(value: unknown): value is Suspect {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Suspect>;
  return typeof item.record?.id === "string" && typeof item.record?.name === "string" &&
    typeof item.score === "number" && Array.isArray(item.signals);
}

export async function syncBiography(env: AppEnv, suspect: Suspect): Promise<Biography> {
  const id = env.ResourceBiography.idFromName(`${suspect.record.zoneId}:${suspect.record.id}`);
  const response = await env.ResourceBiography.get(id).fetch("https://biography.internal/sync", { method: "POST", body: JSON.stringify(suspect) });
  if (!response.ok) throw new Error(`Biography sync failed (${response.status})`);
  return response.json() as Promise<Biography>;
}

export async function biographyRequest(env: AppEnv, zoneId: string, recordId: string, path: string, body?: unknown): Promise<Response> {
  const id = env.ResourceBiography.idFromName(`${zoneId}:${recordId}`);
  return env.ResourceBiography.get(id).fetch(new Request(`https://biography.internal${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) }));
}
