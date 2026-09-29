import { Agent } from "agents";
import { MockClient } from "./clients/mock";
import { syncBiography } from "./biography";
import type { AppEnv } from "./env";
import { chooseEvidence, renderEvidenceSummary } from "./openrouter";
import { isEligible, scoreRecord } from "./scoring";
import type { DnsRecord } from "./types";

interface ChatInput { message?: unknown; recordId?: unknown; zoneId?: unknown }

export class GraveyardAgent extends Agent<AppEnv> {
  onStart(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversation (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, record_id TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const sql = this.ctx.storage.sql;
    if (path === "/history" && request.method === "GET") {
      const messages = [...sql.exec<{ at: string; role: string; content: string; recordId: string | null }>(
        "SELECT at, role, content, record_id AS recordId FROM conversation ORDER BY id DESC LIMIT 40"
      )].reverse();
      return Response.json({ messages });
    }
    if (path !== "/chat" || request.method !== "POST") return Response.json({ error: "Not found" }, { status: 404 });

    let input: ChatInput;
    try { input = await request.json() as ChatInput; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 1000 || input.zoneId !== "mock-zone") {
      return Response.json({ error: "Invalid chat request" }, { status: 400 });
    }
    const client = new MockClient();
    const records = (await client.listRecords("mock-zone")).filter((record) => isEligible(record, "example.test", this.env.PROTECTED_NAMES.split(",").map((name) => name.trim())));
    const priorId = [...sql.exec<{ value: string }>("SELECT value FROM agent_meta WHERE key = 'last_record_id'")][0]?.value;
    const record = findRecord(records, input.message, typeof input.recordId === "string" ? input.recordId : undefined, priorId);
    if (!record) return Response.json({ error: "Name an eligible DNS record or pass its recordId." }, { status: 400 });
    if (!this.env.OPENROUTER_API_KEY) return Response.json({ error: "OPENROUTER_API_KEY is not configured" }, { status: 503 });

    const biography = await syncBiography(this.env, await scoreRecord(record, client));
    let answer: string;
    try {
      const decision = await chooseEvidence(biography, this.env.OPENROUTER_API_KEY, this.env.OPENROUTER_MODEL);
      answer = renderEvidenceSummary(biography, decision);
    } catch (error) {
      const message = error instanceof Error ? error.message : "OpenRouter request failed";
      return Response.json({ error: message }, { status: 502 });
    }
    const at = new Date().toISOString();
    sql.exec("INSERT INTO conversation (at, role, content, record_id) VALUES (?, 'user', ?, ?)", at, input.message.trim(), record.id);
    sql.exec("INSERT INTO conversation (at, role, content, record_id) VALUES (?, 'assistant', ?, ?)", at, answer, record.id);
    sql.exec("INSERT INTO agent_meta (key, value) VALUES ('last_record_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", record.id);

    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < answer.length; i += 80) controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ text: answer.slice(i, i + 80) })}\n\n`));
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }
}

function findRecord(records: DnsRecord[], message: string, explicitId?: string, priorId?: string): DnsRecord | undefined {
  const lower = message.toLowerCase();
  const mentioned = records.find((record) => lower.includes(record.name.toLowerCase()));
  if (explicitId) return records.find((record) => record.id === explicitId && (!mentioned || mentioned.id === explicitId));
  if (mentioned) return mentioned;
  if (/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.example\.test\b/.test(lower)) return undefined;
  return records.find((record) => record.id === priorId);
}
