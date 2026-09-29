import { z } from "zod";
import type { Biography } from "./biography";
import type { Signal } from "./types";

const kinds = ["unresolved-target", "stale", "zero-traffic", "name-heuristic"] as const;
const decisionSchema = z.object({
  purpose: z.literal("unknown"),
  evidenceKinds: z.array(z.enum(kinds)).max(4),
  assessment: z.enum(["investigate", "insufficient_evidence"])
}).strict();

export type ModelDecision = z.infer<typeof decisionSchema>;
type Fetcher = typeof fetch;

export async function chooseEvidence(biography: Biography, apiKey: string, model: string, fetcher: Fetcher = fetch): Promise<ModelDecision> {
  if (!apiKey) throw new Error("OpenRouter API key is missing");
  const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      provider: { require_parameters: true },
      temperature: 0,
      max_tokens: 150,
      messages: [
        { role: "system", content: "Select evidence kinds that matter for reviewing a DNS record. Its purpose is always unknown. Do not infer safety or propose actions." },
        { role: "user", content: JSON.stringify({ name: biography.record.name, type: biography.record.type, content: biography.record.content, score: biography.score, signals: biography.signals }) }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "dns_evidence_selection",
          strict: true,
          schema: {
            type: "object", additionalProperties: false,
            properties: {
              purpose: { type: "string", enum: ["unknown"] },
              evidenceKinds: { type: "array", items: { type: "string", enum: kinds }, maxItems: 4 },
              assessment: { type: "string", enum: ["investigate", "insufficient_evidence"] }
            },
            required: ["purpose", "evidenceKinds", "assessment"]
          }
        }
      }
    })
  });
  if (!response.ok) throw new Error(`OpenRouter request failed (${response.status})`);
  const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) throw new Error("OpenRouter returned no structured content");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("OpenRouter returned invalid JSON"); }
  const decision = decisionSchema.parse(parsed);
  const available = new Set(biography.signals.map((signal) => signal.kind));
  if (decision.evidenceKinds.some((kind) => !available.has(kind))) throw new Error("OpenRouter cited unavailable evidence");
  if (new Set(decision.evidenceKinds).size !== decision.evidenceKinds.length) throw new Error("OpenRouter repeated evidence");
  return decision;
}

export function renderEvidenceSummary(biography: Biography, decision: ModelDecision): string {
  const selected = biography.signals.filter((signal: Signal) => decision.evidenceKinds.includes(signal.kind));
  const evidence = selected.length ? selected.map((signal) => signal.evidence).join(" ") : "No confirmed suspect signals were selected.";
  return `${biography.record.name} (${biography.record.type}) has a suspect score of ${biography.score}. Purpose: unknown. ${evidence} ` +
    "This evidence does not establish that deletion is safe. No DNS change has been made.";
}
