import { z } from "zod";
import type { Biography } from "./biography";
import type { AppEnv } from "./env";
import type { DnsRecord } from "./types";

export interface Obituary {
  recordId: string;
  name: string;
  type: DnsRecord["type"];
  born: string;
  died: string;
  cause: string;
  survivors: string[];
  lastWords: string;
  epitaph: string;
  epitaphSource: "openrouter" | "fallback";
}

export function obituaryFacts(biography: Biography, records: DnsRecord[]): Omit<Obituary, "epitaph" | "epitaphSource"> {
  if (biography.state !== "deleted") throw new Error("Only deleted records get obituaries");
  const died = biography.events.filter((event) => event.kind === "deleted").at(-1)?.at;
  if (!died) throw new Error("Deletion event is missing");
  const started = biography.events.filter((event) => event.kind === "quarantined").at(-1)?.at;
  const seconds = started ? Math.max(0, Math.round((Date.parse(died) - Date.parse(started)) / 1000)) : 0;
  const workflowId = biography.quarantine?.workflowId;
  const screams = biography.hits.filter((hit) => hit.counted && hit.workflowId === workflowId).length;
  const lastHit = biography.hits.at(-1);
  return {
    recordId: biography.record.id,
    name: biography.snapshot.name,
    type: biography.snapshot.type,
    born: biography.snapshot.createdOn,
    died,
    cause: `Quarantined ${seconds} seconds; ${screams} counted screams.`,
    survivors: records.filter((record) => record.id !== biography.record.id && record.content === biography.snapshot.content).map((record) => record.name),
    lastWords: lastHit ? `${lastHit.at}: ${lastHit.path} (${lastHit.country}; ${lastHit.reason})` : "none"
  };
}

const lineSchema = z.object({
  opening: z.enum(["Here rests", "In memory of", "Farewell to"]),
  detail: z.enum(["name", "type", "cause", "lastWords"]),
  closing: z.enum(["Remembered by its records.", "Its final state is recorded."])
}).strict();

export async function writeEpitaph(facts: ReturnType<typeof obituaryFacts>, env: AppEnv, fetcher: typeof fetch = fetch): Promise<Pick<Obituary, "epitaph" | "epitaphSource">> {
  const fallback = { epitaph: `Here rests ${facts.name}; ${facts.cause}`, epitaphSource: "fallback" as const };
  const model: string = env.OPENROUTER_MODEL;
  if (!env.OPENROUTER_API_KEY || (model !== "openrouter/free" && !model.endsWith(":free"))) return fallback;
  try {
    const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model, provider: { require_parameters: true }, temperature: 0, max_completion_tokens: 3000,
        messages: [
          { role: "system", content: "Compose a one-line DNS obituary by selecting exactly one allowed opening, fact detail, and closing. Never invent purpose or usage." },
          { role: "user", content: JSON.stringify(facts) }
        ],
        response_format: { type: "json_schema", json_schema: { name: "dns_epitaph", strict: true, schema: {
          type: "object", additionalProperties: false,
          properties: {
            opening: { type: "string", enum: ["Here rests", "In memory of", "Farewell to"] },
            detail: { type: "string", enum: ["name", "type", "cause", "lastWords"] },
            closing: { type: "string", enum: ["Remembered by its records.", "Its final state is recorded."] }
          }, required: ["opening", "detail", "closing"]
        } } }
      })
    });
    if (!response.ok) {
      console.warn("OpenRouter epitaph request failed", response.status);
      return fallback;
    }
    const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
    const choice = lineSchema.parse(JSON.parse(payload.choices?.[0]?.message?.content ?? "null"));
    const detail = choice.detail === "name" ? facts.name : choice.detail === "type" ? `${facts.name}, a ${facts.type} record` : choice.detail === "lastWords" ? `the last observed request: ${facts.lastWords}` : `${facts.name}; ${facts.cause}`;
    return { epitaph: `${choice.opening} ${detail}. ${choice.closing}`.replace("..", "."), epitaphSource: "openrouter" };
  } catch (error) {
    console.warn("OpenRouter epitaph response was unusable", error instanceof Error ? error.name : "unknown");
    return fallback;
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

export function obituaryPage(obituary: Obituary, origin: string): Response {
  const e = escapeHtml;
  const title = `${obituary.name} · Graveyard Shift`;
  const description = `${obituary.type} record. ${obituary.cause} ${obituary.epitaph}`;
  const url = `${origin}/obituary/${encodeURIComponent(obituary.recordId)}`;
  const survivors = obituary.survivors.length ? obituary.survivors.map((name) => `<li>${e(name)}</li>`).join("") : "<li>None recorded</li>";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title><meta name="description" content="${e(description)}"><meta property="og:type" content="article"><meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(description)}"><meta property="og:url" content="${e(url)}"><meta name="twitter:card" content="summary"><style>body{margin:0;background:#11131a;color:#f5f1e8;font:17px/1.6 system-ui,sans-serif}main{max-width:730px;margin:8vh auto;padding:32px}a{color:#c8a86b}.eyebrow{color:#c8a86b;text-transform:uppercase;letter-spacing:.18em;font-size:12px}h1{font:clamp(36px,7vw,68px)/1.05 Georgia,serif;overflow-wrap:anywhere}h2{font:24px Georgia,serif}dl{display:grid;grid-template-columns:140px 1fr;gap:14px;border-top:1px solid #444;padding-top:24px}dt{color:#bdb5a8}dd{margin:0;overflow-wrap:anywhere}blockquote{font:italic 28px/1.4 Georgia,serif;color:#e6c28c;margin:40px 0}li{overflow-wrap:anywhere}@media(max-width:600px){dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:14px}}</style></head><body><main><p class="eyebrow">Graveyard Shift · Obituary</p><h1>${e(obituary.name)}</h1><p>${e(obituary.type)} DNS record</p><blockquote>${e(obituary.epitaph)}</blockquote><dl><dt>Born</dt><dd>${e(obituary.born)}</dd><dt>Died</dt><dd>${e(obituary.died)}</dd><dt>Cause of death</dt><dd>${e(obituary.cause)}</dd><dt>Last words</dt><dd>${e(obituary.lastWords)}</dd></dl><h2>Survivors</h2><ul>${survivors}</ul><p><a href="/">Return to Graveyard Shift</a></p></main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff" } });
}
