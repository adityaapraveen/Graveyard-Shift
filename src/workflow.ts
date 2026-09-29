import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { MockClient } from "./clients/mock";
import { biographyRequest, syncBiography } from "./biography";
import type { Biography } from "./biography";
import type { AppEnv } from "./env";
import { scoreRecord } from "./scoring";
import type { DnsRecord } from "./types";

export interface QuarantineParams {
  zoneId: string;
  recordId: string;
  snapshot: DnsRecord;
  deadlineAt: string;
  quarantineSeconds: number;
  screamThreshold: number;
  workflowId: string;
}

const retries = { retries: { limit: 3, delay: "1 second" as const, backoff: "linear" as const } };

export class QuarantineWorkflow extends WorkflowEntrypoint<AppEnv, QuarantineParams> {
  async run(event: WorkflowEvent<QuarantineParams>, step: WorkflowStep): Promise<{ state: "resurrected" | "deleted" }> {
    const params = event.payload;
    if (String(this.env.DRY_RUN) !== "false" || this.env.CF_MODE !== "mock") throw new Error("Workflow cannot mutate in this mode");
    if (params.zoneId !== "mock-zone" || params.snapshot.id !== params.recordId || params.snapshot.zoneId !== params.zoneId) throw new Error("Invalid workflow payload");
    const client = new MockClient(this.env);

    await step.do("snapshot", retries, async () => {
      const reservation = await client.zoneFetch(`/quarantine/${params.recordId}`);
      const status = await requireJson<{ workflowId: string; state: string }>(reservation);
      if (status.workflowId !== params.workflowId || !["starting", "quarantined"].includes(status.state)) throw new Error("Reservation mismatch");
      await syncBiography(this.env, await scoreRecord(params.snapshot, client));
      await requireJson(await biographyRequest(this.env, params.zoneId, params.recordId, "/snapshot", {
        snapshot: params.snapshot, workflowId: params.workflowId, deadlineAt: params.deadlineAt, threshold: params.screamThreshold
      }));
    });

    await step.do("apply quarantine", retries, async () => {
      const applied = await requireJson<{ startedAt: string }>(await client.zoneFetch("/apply", { recordId: params.recordId }));
      const deadlineAt = new Date(Date.parse(applied.startedAt) + params.quarantineSeconds * 1000).toISOString();
      await requireJson(await biographyRequest(this.env, params.zoneId, params.recordId, "/quarantined", { deadlineAt }));
    });

    for (let check = 0; check < params.quarantineSeconds; check++) {
      await step.sleep(`wait ${check}`, 1000);
      const biography = await step.do(`check ${check}`, retries, async () => requireJson<Biography>(await biographyRequest(this.env, params.zoneId, params.recordId, "/")));
      if (shouldResurrect(biography)) break;
    }

    return step.do("finalize", retries, async () => {
      const biography = await requireJson<Biography>(await biographyRequest(this.env, params.zoneId, params.recordId, "/"));
      if (shouldResurrect(biography)) {
        await this.restore(client, params);
        return { state: "resurrected" as const };
      }
      await requireJson(await client.zoneFetch("/delete", { recordId: params.recordId }));
      await requireJson(await biographyRequest(this.env, params.zoneId, params.recordId, "/deleted", {}));
      return { state: "deleted" as const };
    });
  }

  private async restore(client: MockClient, params: QuarantineParams): Promise<void> {
    await requireJson(await client.zoneFetch("/restore", { recordId: params.recordId }));
    await requireJson(await biographyRequest(this.env, params.zoneId, params.recordId, "/resurrected", {}));
  }
}

function shouldResurrect(biography: Biography): boolean {
  return biography.state === "quarantined" && !!biography.quarantine &&
    (biography.quarantine.resurrectRequested || biography.hits.filter((hit) => hit.counted && hit.workflowId === biography.quarantine?.workflowId).length >= biography.quarantine.threshold);
}

async function requireJson<T = unknown>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Quarantine step failed (${response.status})`);
  return response.json() as Promise<T>;
}
