import { z } from "zod";
import { organizationJobSchema, organizationRequestSchema } from "./organization-schema";
import type { OrganizationJob, OrganizationRequest } from "./organization-types";

/**
 * Public boundary for the durable organization outbox. The queue accepts only
 * source analysis and knowledge drafts; update and relation reviews continue
 * through their interactive flow because they need live note revision checks.
 */
export const durableOrganizationRequestSchema = organizationRequestSchema.superRefine(
  (request, context) => {
    if (request.kind !== "source" && request.kind !== "knowledge")
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "仅资料分析和知识草稿任务支持后台执行。",
      });
  },
);

export const organizationJobIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const organizationExpectedRevisionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const organizationTimestampSchema = z.string().datetime({ offset: true });

export const enqueueOrganizationJobInputSchema = z
  .object({
    request: durableOrganizationRequestSchema,
    expectedRevision: organizationExpectedRevisionSchema,
  })
  .strict();

export const cancelOrganizationJobInputSchema = z
  .object({
    jobId: organizationJobIdSchema,
    expectedRevision: organizationExpectedRevisionSchema,
  })
  .strict();

/**
 * The server may inspect a full persisted projection to verify its shape, but
 * this browser-facing protocol never exposes a generated model result. The
 * existing workspace sync remains the single path that publishes results.
 */
const durableOrganizationJobSchema = organizationJobSchema.superRefine((job, context) => {
  if (job.durable !== true)
    context.addIssue({
      code: "custom",
      path: ["durable"],
      message: "后台任务必须标记为 durable。",
    });
  if (job.request.kind !== "source" && job.request.kind !== "knowledge")
    context.addIssue({
      code: "custom",
      path: ["request", "kind"],
      message: "后台任务只能处理资料分析或知识草稿。",
    });
});

const rawEnqueueOrganizationJobResponseSchema = z
  .object({
    revision: organizationExpectedRevisionSchema,
    job: durableOrganizationJobSchema,
    created: z.boolean(),
  })
  .strict();
const rawCancelOrganizationJobResponseSchema = z
  .object({
    revision: organizationExpectedRevisionSchema,
    job: durableOrganizationJobSchema,
    cancelled: z.boolean(),
  })
  .strict();

export const reconcileOrganizationJobsResponseSchema = z
  .object({
    revision: organizationExpectedRevisionSchema,
    jobs: z
      .array(
        z
          .object({
            id: organizationJobIdSchema,
            state: z.enum(["queued", "running"]),
            updatedAt: organizationTimestampSchema,
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

export type DurableOrganizationRequest = OrganizationRequest & {
  kind: "source" | "knowledge";
};
export type DurableOrganizationJob = Omit<OrganizationJob, "result">;
export type EnqueueOrganizationJobResult = {
  revision: number;
  job: DurableOrganizationJob;
  created: boolean;
};
export type CancelOrganizationJobResult = {
  revision: number;
  job: DurableOrganizationJob;
  cancelled: boolean;
};
export type ReconciledOrganizationJob = {
  id: string;
  state: "queued" | "running";
  updatedAt: string;
};
export type ReconcileOrganizationJobsResult = {
  revision: number;
  jobs: ReconciledOrganizationJob[];
};

function withoutModelResult(job: OrganizationJob): DurableOrganizationJob {
  const { result: _result, ...safe } = job;
  return safe;
}

/** Returns null when an RPC result is not a complete, safe response contract. */
export function parseEnqueueOrganizationJobResult(
  value: unknown,
): EnqueueOrganizationJobResult | null {
  const parsed = rawEnqueueOrganizationJobResponseSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    revision: parsed.data.revision,
    job: withoutModelResult(parsed.data.job),
    created: parsed.data.created,
  };
}

/** Returns null when an RPC result is not a complete, safe response contract. */
export function parseCancelOrganizationJobResult(
  value: unknown,
): CancelOrganizationJobResult | null {
  const parsed = rawCancelOrganizationJobResponseSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    revision: parsed.data.revision,
    job: withoutModelResult(parsed.data.job),
    cancelled: parsed.data.cancelled,
  };
}
