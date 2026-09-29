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
  hits: { at: string; ipHash: string; userAgent: string; path: string; country: string }[];
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
        path TEXT NOT NULL, country TEXT NOT NULL
      );
    `);
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
      hits: [...sql.exec<{ at: string; ipHash: string; userAgent: string; path: string; country: string }>("SELECT at, ip_hash AS ipHash, user_agent AS userAgent, path, country FROM sinkhole_hits ORDER BY id")]
    };
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
