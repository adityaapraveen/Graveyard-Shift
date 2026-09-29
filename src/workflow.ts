import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { MockClient } from "./clients/mock";
import { RealClient, realConfig } from "./clients/real";
import { biographyRequest, syncBiography } from "./biography";
import type { Biography } from "./biography";
import type { AppEnv } from "./env";
import { scoreRecord } from "./scoring";
import type { DnsRecord } from "./types";
import { obituaryFacts, writeEpitaph } from "./obituary";

export interface QuarantineParams {
  zoneId: string;
  recordId: string;
  snapshot: DnsRecord;
  deadlineAt: string;
  quarantineSeconds: number;
  screamThreshold: number;
  workflowId: string;
  mode?: "mock" | "real";
}

const retries = { retries: { limit: 3, delay: "1 second" as const, backoff: "linear" as const } };

export class QuarantineWorkflow extends WorkflowEntrypoint<AppEnv, QuarantineParams> {
  async run(event: WorkflowEvent<QuarantineParams>, step: WorkflowStep): Promise<{ state: "resurrected" | "deleted" }> {
    const params = event.payload;
    const mode = params.mode ?? "mock";
    if (String(this.env.DRY_RUN) !== "false" || String(this.env.CF_MODE) !== mode) throw new Error("Workflow cannot mutate in this mode");
    if ((mode === "mock" && params.zoneId !== "mock-zone") || (mode === "real" && params.zoneId !== realConfig(this.env).zoneId) || params.snapshot.id !== params.recordId || params.snapshot.zoneId !== params.zoneId) throw new Error("Invalid workflow payload");
    const client = mode === "mock" ? new MockClient(this.env) : new RealClient(this.env);

    await step.do("snapshot", retries, async () => {
      const reservation = await client.zoneFetch(`/quarantine/${params.recordId}`);
      const status = await requireJson<{ workflowId: string; state: string }>(reservation);
      if (status.workflowId !== params.workflowId || !["starting", "quarantined"].includes(status.state)) throw new Error("Reservation mismatch");
      await syncBiography(this.env, await scoreRecord(params.snapshot, client));
      await requireJson(await biographyRequest(this.env, params.zoneId, params.recordId, "/snapshot", {
        snapshot: params.snapshot, workflowId: params.workflowId, deadlineAt: params.deadlineAt, threshold: params.screamThreshold
      }));
    });

    try {
      await step.do("apply quarantine", retries, async () => {
        const applied = await requireJson<{ startedAt: string }>(await client.zoneFetch("/apply", { recordId: params.recordId }));
        const deadlineAt = new Date(Date.parse(applied.startedAt) + params.quarantineSeconds * 1000).toISOString();
        await requireJson(await biographyRequest(this.env, params.zoneId, params.recordId, "/quarantined", { deadlineAt }));
      });
    } catch (error) {
      if (mode !== "real") throw error;
      await step.do("rollback failed apply", retries, async () => this.restore(client, params));
      return { state: "resurrected" };
    }

    const intervalMs = mode === "mock" ? 1000 : 30 * 60_000;
    const checks = Math.ceil(params.quarantineSeconds * 1000 / intervalMs);
    for (let check = 0; check < checks; check++) {
      await step.sleep(`wait ${check}`, Math.min(intervalMs, params.quarantineSeconds * 1000 - check * intervalMs));
      const biography = await step.do(`check ${check}`, retries, async () => requireJson<Biography>(await biographyRequest(this.env, params.zoneId, params.recordId, "/")));
      if (shouldResurrect(biography)) break;
    }

    const result = await step.do("finalize", retries, async () => {
      const biography = await requireJson<Biography>(await biographyRequest(this.env, params.zoneId, params.recordId, "/"));
      if (shouldResurrect(biography)) {
        await this.restore(client, params);
        return { state: "resurrected" as const };
      }
      await requireJson(await client.zoneFetch("/delete", { recordId: params.recordId }));
      await requireJson(await biographyRequest(this.env, params.zoneId, params.recordId, "/deleted", {}));
      return { state: "deleted" as const };
    });
    if (result.state === "deleted") await step.do("write obituary", retries, async () => {
      const biography = await requireJson<Biography>(await biographyRequest(this.env, params.zoneId, params.recordId, "/"));
      if (biography.obituary) return;
      const facts = obituaryFacts(biography, await client.listRecords(params.zoneId));
      const epitaph = await writeEpitaph(facts, this.env);
      await requireJson(await biographyRequest(this.env, params.zoneId, params.recordId, "/obituary", { ...facts, ...epitaph }));
    });
    return result;
  }

  private async restore(client: MockClient | RealClient, params: QuarantineParams): Promise<void> {
    await requireJson(await client.zoneFetch("/restore", { recordId: params.recordId }));
    await requireJson(await biographyRequest(this.env, params.zoneId, params.recordId, "/resurrected", {}));
  }
}

function shouldResurrect(biography: Biography): boolean {
  return biography.state === "resurrected" || biography.state === "quarantined" && !!biography.quarantine &&
    (biography.quarantine.resurrectRequested || biography.hits.filter((hit) => hit.counted && hit.workflowId === biography.quarantine?.workflowId).length >= biography.quarantine.threshold);
}

async function requireJson<T = unknown>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Quarantine step failed (${response.status})`);
  return response.json() as Promise<T>;
}
