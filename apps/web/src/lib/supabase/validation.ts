import { z } from "zod";
import type {
  ReadingPositionAlternative,
  RecoverableSourceAnnotationDraft,
  ResolvedRecoverableSourceAnnotationDraft,
  Source,
  WorkspaceData,
} from "@/lib/types";
import { answerNoteEvidenceSchema, citationSchema } from "@/lib/citation-schema";
import { organizationJobSchema } from "@/lib/organization-schema";
import { noteRevisionSchema } from "@/lib/knowledge-update-schema";
import { conceptRelationSchema } from "@/lib/concept-relation-schema";
import { webSnapshotSchema } from "@/lib/web-types";
import { importJobId } from "@/lib/import-queue";
import { recoverableSourceAnnotationDraftId } from "@/lib/recoverable-drafts";
import { annotationTextAnchorMatches, sameAnnotationTextAnchor } from "@/lib/annotations";
import {
  ANSWER_USER_CONTEXT_ITEM_MAX_CHARS,
  ANSWER_USER_CONTEXT_MAX_CHARS,
  ANSWER_USER_CONTEXT_MAX_ITEMS,
} from "@/lib/answer-context";

export const MAX_WORKSPACE_BYTES = 3 * 1024 * 1024;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const timestamp = z.string().datetime({ offset: true });
const short = z.string().max(512);
const content = z.string().max(MAX_WORKSPACE_BYTES);
const page = z.number().int().min(1).max(100_000).optional();
const readingPositionAlternative = z
  .object({
    origin: z.enum(["local", "remote", "previous"]),
    readPage: page,
    readOffset: z.number().finite().nonnegative().optional(),
    lastReadAt: timestamp.optional(),
  } satisfies Record<keyof ReadingPositionAlternative, z.ZodType>)
  .strict()
  .refine(
    (value) =>
      value.readPage !== undefined ||
      value.readOffset !== undefined ||
      value.lastReadAt !== undefined,
    { message: "阅读位置候选至少需要页码、正文位置或阅读时间。" },
  );
const readingPositionAlternatives = z
  .array(readingPositionAlternative)
  .max(8)
  .superRefine((values, context) => {
    const positions = new Set<string>();
    for (const [index, value] of values.entries()) {
      const key = JSON.stringify([value.readPage, value.readOffset, value.lastReadAt]);
      if (positions.has(key))
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同一阅读位置不能重复保存。",
        });
      positions.add(key);
    }
  });
const citation = citationSchema;
const manualExcerptReference = z
  .object({
    sourceId: id,
    versionId: id,
    chunkId: id,
    selectionFingerprint: z.string().regex(/^[a-f0-9]{16}$/u),
  })
  .strict();
const manualExcerptReferences = z
  .array(manualExcerptReference)
  .max(1_000)
  .superRefine((values, context) => {
    const keys = new Set<string>();
    for (const [index, value] of values.entries()) {
      const key = JSON.stringify([
        value.sourceId,
        value.versionId,
        value.chunkId,
        value.selectionFingerprint,
      ]);
      if (keys.has(key))
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同一人工摘录身份不能重复保存。",
        });
      keys.add(key);
    }
  });
const answerNoteEvidence = answerNoteEvidenceSchema;
const sourceVersionReference = z
  .object({
    sourceId: id,
    versionId: id,
  })
  .strict();
const comparisonIdentity = z
  .object({
    leftSourceId: id,
    leftVersionId: id,
    rightSourceId: id,
    rightVersionId: id,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.leftSourceId === value.rightSourceId)
      context.addIssue({
        code: "custom",
        path: ["rightSourceId"],
        message: "对照会话需要两份不同的资料。",
      });
  });
function isSingleSourceAnswerScope(scope: string) {
  return scope === "selection" || scope === "document" || scope === "document-notes";
}
const answerScopeSnapshot = z
  .object({
    scope: z.enum([
      "selection",
      "document",
      "document-notes",
      "sources",
      "space",
      "cross-library-sources",
    ]),
    sourceId: id.optional(),
    sourceIds: z.array(id).max(5_000),
    sourceVersions: z.array(sourceVersionReference).min(1).max(100).optional(),
    comparison: comparisonIdentity.optional(),
    spaceId: id,
    selection: z.string().max(20_000).optional(),
    userContext: z
      .array(z.string().trim().min(1).max(ANSWER_USER_CONTEXT_ITEM_MAX_CHARS))
      .max(ANSWER_USER_CONTEXT_MAX_ITEMS)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const singleSourceScope = isSingleSourceAnswerScope(value.scope);
    if (
      (value.userContext ?? []).reduce((length, item) => length + item.length, 0) >
      ANSWER_USER_CONTEXT_MAX_CHARS
    )
      context.addIssue({
        code: "custom",
        path: ["userContext"],
        message: "问题上下文长度超出限制。",
      });
    if (value.sourceVersions) {
      const expectedIds = singleSourceScope
        ? value.sourceId
          ? [value.sourceId]
          : []
        : value.sourceIds;
      const expected = new Set(expectedIds);
      const actual = new Set(value.sourceVersions.map((item) => item.sourceId));
      if (
        value.scope === "space" ||
        (singleSourceScope &&
          (value.sourceIds.length !== 1 || value.sourceIds[0] !== value.sourceId)) ||
        expected.size !== expectedIds.length ||
        value.sourceVersions.length !== expected.size ||
        actual.size !== value.sourceVersions.length ||
        value.sourceVersions.some((item) => !expected.has(item.sourceId))
      )
        context.addIssue({
          code: "custom",
          path: ["sourceVersions"],
          message: "固定资料版本必须与指定资料范围一一对应。",
        });
    }
    if (value.scope === "cross-library-sources") {
      const ids = new Set(value.sourceIds);
      const versions = value.sourceVersions
        ? new Set(value.sourceVersions.map((item) => item.sourceId))
        : new Set<string>();
      if (
        value.spaceId !== "all" ||
        value.sourceId !== undefined ||
        value.selection !== undefined ||
        value.comparison !== undefined ||
        value.sourceIds.length < 1 ||
        value.sourceIds.length > 5 ||
        ids.size !== value.sourceIds.length ||
        !value.sourceVersions ||
        value.sourceVersions.length !== ids.size ||
        versions.size !== value.sourceVersions.length ||
        [...ids].some((sourceId) => !versions.has(sourceId))
      )
        context.addIssue({
          code: "custom",
          path: ["scope"],
          message: "跨库问答必须在全部资料库中锁定 1 至 5 份资料及其当前版本。",
        });
    }
    if (value.comparison) {
      const expectedSources = [value.comparison.leftSourceId, value.comparison.rightSourceId];
      const actualSources = new Set(value.sourceIds);
      const expectedVersions = new Map([
        [value.comparison.leftSourceId, value.comparison.leftVersionId],
        [value.comparison.rightSourceId, value.comparison.rightVersionId],
      ]);
      const actualVersions = new Map(
        (value.sourceVersions ?? []).map((item) => [item.sourceId, item.versionId]),
      );
      if (
        value.scope !== "sources" ||
        value.sourceId !== undefined ||
        value.selection !== undefined ||
        value.sourceIds.length !== 2 ||
        actualSources.size !== 2 ||
        expectedSources.some((sourceId) => !actualSources.has(sourceId)) ||
        !value.sourceVersions ||
        value.sourceVersions.length !== 2 ||
        actualVersions.size !== 2 ||
        [...expectedVersions].some(
          ([sourceId, versionId]) => actualVersions.get(sourceId) !== versionId,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["comparison"],
          message: "对照问答必须固定为保存的两份资料与版本。",
        });
    }
  });
const answerAttempt = z
  .object({
    id,
    questionMessageId: id,
    scopeSnapshot: answerScopeSnapshot,
    status: z.enum(["completed", "failed", "stopped"]),
    unavailableReason: z.enum(["source-purged"]).optional(),
  })
  .strict();
const comparisonConversation = comparisonIdentity;
const importJobSchema = z
  .object({
    id,
    sourceId: id,
    versionId: id,
    filename: short,
    spaceId: z.union([id, z.literal("")]),
    stage: z.enum(["saving", "parsing", "indexing"]),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    originalSaved: z.boolean(),
    attempt: z.number().int().min(0).max(100_000),
    createdAt: timestamp,
    updatedAt: timestamp,
    error: z.string().max(10_000).optional(),
    cancelledAt: timestamp.optional(),
    completedAt: timestamp.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.id !== importJobId(value.sourceId, value.versionId))
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "导入任务必须绑定确切资料版本。",
      });
    if (value.status === "failed" && !value.error?.trim())
      context.addIssue({ code: "custom", path: ["error"], message: "失败任务需要保留原因。" });
    if (value.status !== "failed" && value.error !== undefined)
      context.addIssue({ code: "custom", path: ["error"], message: "任务错误状态不一致。" });
    if (value.status === "cancelled" && !value.cancelledAt)
      context.addIssue({ code: "custom", path: ["cancelledAt"], message: "取消时间缺失。" });
    if (value.status !== "cancelled" && value.cancelledAt !== undefined)
      context.addIssue({ code: "custom", path: ["cancelledAt"], message: "任务取消状态不一致。" });
    if (value.status === "completed") {
      if (!value.originalSaved || value.stage !== "indexing" || !value.completedAt)
        context.addIssue({ code: "custom", path: ["status"], message: "完成任务状态不一致。" });
    } else if (value.completedAt !== undefined)
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "未完成任务不能标为完成。",
      });
  });
const chunk = z
  .object({
    id,
    sourceId: id,
    versionId: id,
    text: content,
    section: short,
    page,
    order: z.number().int().min(0).max(100_000),
  })
  .strict();
const sourcePageRange = z
  .object({
    start: z.number().int().min(1).max(100_000),
    end: z.number().int().min(1).max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.end < value.start)
      context.addIssue({ code: "custom", path: ["end"], message: "页码范围结束位置无效。" });
  });
const sourceCoverageSchema = z
  .object({
    captureScope: z.enum(["full", "selection", "manual", "link"]),
    parseState: z.enum(["pending", "complete", "partial", "failed", "not-requested"]),
    unavailablePageRanges: z.array(sourcePageRange).min(1).max(100_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ranges = value.unavailablePageRanges ?? [];
    for (let index = 1; index < ranges.length; index++)
      if (ranges[index].start <= ranges[index - 1].end)
        context.addIssue({
          code: "custom",
          path: ["unavailablePageRanges", index],
          message: "不可用页码范围必须按顺序且不重叠。",
        });
    if (
      ranges.length &&
      (value.captureScope !== "full" || !["partial", "failed"].includes(value.parseState))
    )
      context.addIssue({
        code: "custom",
        path: ["unavailablePageRanges"],
        message: "不可用页码范围只能描述完整资料的真实解析缺失。",
      });
  });
const sourceBase = z
  .object({
    id,
    versionId: id,
    title: short,
    filename: short,
    kind: z.enum(["pdf", "docx", "markdown", "text", "web"]),
    mime: z.string().max(200),
    size: z
      .number()
      .int()
      .min(0)
      .max(50 * 1024 * 1024),
    hash: z.string().max(200),
    spaceIds: z.array(id).max(500),
    tags: z.array(z.string().max(100)).max(100),
    tagsLocked: z.boolean().optional(),
    tagsRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1)
      .optional(),
    status: z.enum(["saved", "parsing", "ready", "partial", "failed", "link-only"]),
    coverage: sourceCoverageSchema.optional(),
    text: content,
    chunks: z.array(chunk).max(20_000),
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: timestamp.nullable(),
    aiAllowed: z.boolean(),
    starred: z.boolean(),
    pageCount: z.number().int().min(0).max(100_000).optional(),
    parsedPages: z.number().int().min(0).max(100_000).optional(),
    error: z.string().max(10_000).optional(),
    url: z.string().url().max(8192).optional(),
    webSnapshot: webSnapshotSchema.optional(),
    blobKey: z.string().max(512).optional(),
    storagePath: z.string().max(512).optional(),
    originalMissing: z.boolean().optional(),
    readPage: page,
    readOffset: z.number().finite().nonnegative().optional(),
    lastReadAt: timestamp.optional(),
    readingPositionAlternatives: readingPositionAlternatives.optional(),
  } satisfies Record<Exclude<keyof Source, "versions" | "versionCreatedAt">, z.ZodType>)
  .strict();

function validateSourceCoverage(
  value: Pick<Source, "kind" | "status" | "coverage" | "text" | "chunks" | "pageCount">,
  context: z.RefinementCtx,
) {
  const coverage = value.coverage;
  if (!coverage) return;
  const hasText = Boolean(value.text.trim() && value.chunks.length);
  const ranges = coverage.unavailablePageRanges ?? [];
  const exceedsPageCount =
    value.pageCount !== undefined && ranges.some((range) => range.end > value.pageCount!);
  const inconsistent =
    exceedsPageCount ||
    (coverage.captureScope === "link" &&
      (value.kind !== "web" ||
        coverage.parseState !== "not-requested" ||
        value.status !== "link-only" ||
        hasText)) ||
    (["selection", "manual"].includes(coverage.captureScope) &&
      (value.kind !== "web" ||
        coverage.parseState !== "complete" ||
        value.status !== "ready" ||
        !hasText)) ||
    (coverage.captureScope === "full" &&
      ((coverage.parseState === "complete" && (value.status !== "ready" || !hasText)) ||
        (coverage.parseState === "partial" && (value.status !== "partial" || !hasText)) ||
        (coverage.parseState === "failed" && value.status !== "failed") ||
        (coverage.parseState === "pending" && !["saved", "parsing"].includes(value.status)) ||
        coverage.parseState === "not-requested"));
  if (inconsistent)
    context.addIssue({
      code: "custom",
      path: ["coverage"],
      message: "资料采集范围、解析状态和可检索正文不一致。",
    });
}

function validateWebSnapshot(
  value: Pick<
    Source,
    | "webSnapshot"
    | "kind"
    | "url"
    | "status"
    | "coverage"
    | "text"
    | "chunks"
    | "originalMissing"
    | "blobKey"
    | "storagePath"
  >,
  context: z.RefinementCtx,
) {
  if (value.originalMissing && (value.blobKey || value.storagePath))
    context.addIssue({
      code: "custom",
      path: ["originalMissing"],
      message: "缺失原件不能同时绑定可用原件路径",
    });
  const snapshot = value.webSnapshot;
  if (!snapshot) {
    if (value.coverage && ["selection", "manual", "link"].includes(value.coverage.captureScope))
      context.addIssue({
        code: "custom",
        path: ["webSnapshot"],
        message: "网页选段、手动内容和链接资料必须保留对应的网页采集信息",
      });
    return;
  }
  const coverageMismatch =
    snapshot.scope === "link"
      ? value.coverage &&
        (value.coverage.captureScope !== "link" || value.coverage.parseState !== "not-requested")
      : snapshot.scope === "selection"
        ? value.coverage &&
          (value.coverage.captureScope !== "selection" ||
            value.coverage.parseState !== "complete" ||
            value.status !== "ready")
        : snapshot.scope === "pasted"
          ? value.coverage &&
            (value.coverage.captureScope !== "manual" ||
              value.coverage.parseState !== "complete" ||
              value.status !== "ready")
          : value.coverage &&
            (value.coverage.captureScope !== "full" ||
              value.coverage.parseState !== "complete" ||
              value.status !== "ready");
  const inconsistent =
    value.kind !== "web" ||
    value.url !== snapshot.originalUrl ||
    (snapshot.scope === "link"
      ? value.status !== "link-only" || !!value.text || !!value.chunks.length
      : !["ready", "partial"].includes(value.status) ||
        !value.text.trim() ||
        !value.chunks.length) ||
    coverageMismatch ||
    (snapshot.method === "manual" && snapshot.finalUrl !== snapshot.originalUrl);
  if (inconsistent)
    context.addIssue({
      code: "custom",
      path: ["webSnapshot"],
      message: "网页资料与采集范围或正文状态不一致",
    });
}

const sourceVersion = sourceBase
  .pick({
    versionId: true,
    title: true,
    filename: true,
    kind: true,
    mime: true,
    size: true,
    hash: true,
    status: true,
    coverage: true,
    text: true,
    chunks: true,
    pageCount: true,
    parsedPages: true,
    error: true,
    url: true,
    webSnapshot: true,
    blobKey: true,
    storagePath: true,
    originalMissing: true,
  })
  .extend({ createdAt: timestamp, archivedAt: timestamp })
  .superRefine((value, context) => {
    validateSourceCoverage(value, context);
    validateWebSnapshot(value, context);
  });

const source = sourceBase
  .extend({
    versionCreatedAt: timestamp.optional(),
    versions: z.array(sourceVersion).max(200).optional(),
  })
  .superRefine((value, context) => {
    validateSourceCoverage(value, context);
    validateWebSnapshot(value, context);
    if (!value.versions?.length) return;
    const versions = [value, ...value.versions];
    if (new Set(versions.map((version) => version.versionId)).size !== versions.length)
      context.addIssue({ code: "custom", path: ["versions"], message: "资料包含重复版本标识" });
    for (const version of versions) {
      if (
        (version.kind === "web") !== (value.kind === "web") ||
        new Set(version.chunks.map((item) => item.id)).size !== version.chunks.length ||
        version.chunks.some(
          (item) =>
            item.sourceId !== value.id ||
            item.versionId !== version.versionId ||
            !version.text.includes(item.text),
        )
      )
        context.addIssue({
          code: "custom",
          path: ["versions"],
          message: "历史快照与资料或片段身份不一致",
        });
    }
  });

const annotationTextAnchor = z
  .object({
    start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    end: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine((value) => value.start < value.end, { message: "批注原文位置范围无效。" });

const recoverableSourceAnnotationDraft = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    kind: z.literal("source-annotation"),
    reason: z.literal("source-deleted-during-offline-edit"),
    sourceId: id,
    sourceVersionId: id,
    sourceTitle: short,
    sourceDeletedAt: timestamp,
    annotationId: id,
    annotationCreatedAt: timestamp,
    quote: content.refine((value) => value.trim().length > 0, {
      message: "可恢复草稿必须保留原文上下文。",
    }),
    note: content.refine((value) => value.trim().length > 0, {
      message: "可恢复草稿必须包含人工文字。",
    }),
    page,
    textAnchor: annotationTextAnchor.optional(),
    capturedAt: timestamp,
  } satisfies Record<keyof RecoverableSourceAnnotationDraft, z.ZodType>)
  .strict()
  .superRefine((value, context) => {
    if (value.capturedAt !== value.sourceDeletedAt)
      context.addIssue({
        code: "custom",
        path: ["capturedAt"],
        message: "可恢复草稿的捕获时间必须与资料删除事件一致。",
      });
    if (value.id !== recoverableSourceAnnotationDraftId(value.annotationId, value.sourceDeletedAt))
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "可恢复草稿标识与批注及删除事件不一致。",
      });
  });

const resolvedRecoverableSourceAnnotationDraft = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    sourceId: id,
    annotationId: id,
    sourceDeletedAt: timestamp,
    annotationDisposition: z.enum(["retain", "remove"]).optional(),
  } satisfies Record<keyof ResolvedRecoverableSourceAnnotationDraft, z.ZodType>)
  .strict()
  .superRefine((value, context) => {
    if (value.id !== recoverableSourceAnnotationDraftId(value.annotationId, value.sourceDeletedAt))
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "已处理草稿标识与批注及删除事件不一致。",
      });
  });

export const workspaceSchema: z.ZodType<WorkspaceData> = z
  .object({
    schemaVersion: z.literal(1),
    spaces: z
      .array(
        z
          .object({
            // These virtual IDs carry a security boundary in answer routes and
            // persisted cross-library conversations. A real space must never
            // be allowed to impersonate either one.
            id: id.refine((value) => value !== "all" && value !== "inbox", {
              message: "学习空间不能使用系统保留标识。",
            }),
            name: short.refine((value) => value.trim().length > 0, {
              message: "学习空间名称不能为空。",
            }),
            goal: z.string().max(10_000),
            color: z.string().max(100),
            archived: z.boolean(),
            createdAt: timestamp,
          })
          .strict(),
      )
      .max(500),
    sources: z.array(source).max(5_000),
    notes: z
      .array(
        z
          .object({
            id,
            spaceId: id,
            title: short,
            content,
            kind: z.enum(["note", "knowledge"]),
            aiGenerated: z.boolean().optional(),
            contentRevision: noteRevisionSchema.optional(),
            status: z.enum(["draft", "accepted"]),
            citations: z.array(citation).max(1000),
            manualExcerptRefs: manualExcerptReferences.optional(),
            versions: z
              .array(
                z
                  .object({
                    id,
                    title: short,
                    content,
                    savedAt: timestamp,
                    citations: z.array(citation).max(1000).optional(),
                    status: z.enum(["draft", "accepted"]).optional(),
                    aiGenerated: z.boolean().optional(),
                    spaceId: id.optional(),
                    contentRevision: noteRevisionSchema.optional(),
                    manualExcerptRefs: manualExcerptReferences.optional(),
                  })
                  .strict(),
              )
              .max(200),
            createdAt: timestamp,
            updatedAt: timestamp,
            deletedAt: timestamp.nullable(),
          })
          .strict(),
      )
      .max(10_000),
    annotations: z
      .array(
        z
          .object({
            id,
            sourceId: id,
            versionId: id,
            quote: content,
            note: content,
            page,
            textAnchor: annotationTextAnchor.optional(),
            createdAt: timestamp,
          })
          .strict(),
      )
      .max(20_000),
    recoverableDrafts: z.array(recoverableSourceAnnotationDraft).max(20_000).optional(),
    resolvedRecoverableDrafts: z
      .array(resolvedRecoverableSourceAnnotationDraft)
      .max(20_000)
      .optional(),
    conversations: z
      .array(
        z
          .object({
            id,
            spaceId: id,
            sourceId: id.optional(),
            title: short,
            scope: z.enum([
              "selection",
              "document",
              "document-notes",
              "sources",
              "space",
              "cross-library-sources",
            ]),
            sourceIds: z.array(id).max(5_000),
            comparison: comparisonConversation.optional(),
            resolved: z.boolean(),
            updatedAt: timestamp,
            messages: z
              .array(
                z
                  .object({
                    id,
                    role: z.enum(["user", "assistant"]),
                    content,
                    citations: z.array(citation).max(1000),
                    noteEvidence: z.array(answerNoteEvidence).max(12).optional(),
                    createdAt: timestamp,
                    mode: z.enum(["extractive", "model"]).optional(),
                    error: z.string().max(10_000).optional(),
                    attempt: answerAttempt.optional(),
                  })
                  .strict(),
              )
              .max(1000),
          })
          .strict()
          .superRefine((conversation, context) => {
            if (conversation.scope === "cross-library-sources") {
              const ids = new Set(conversation.sourceIds);
              if (
                conversation.spaceId !== "all" ||
                conversation.sourceId !== undefined ||
                conversation.comparison !== undefined ||
                conversation.sourceIds.length < 1 ||
                conversation.sourceIds.length > 5 ||
                ids.size !== conversation.sourceIds.length
              )
                context.addIssue({
                  code: "custom",
                  path: ["scope"],
                  message: "跨库会话必须保存全部资料库中明确选择的 1 至 5 份资料。",
                });
              const firstSnapshot = conversation.messages.find((message) => message.attempt)
                ?.attempt?.scopeSnapshot;
              const fixedVersions = new Map(
                (firstSnapshot?.sourceVersions ?? []).map((item) => [
                  item.sourceId,
                  item.versionId,
                ]),
              );
              for (const [messageIndex, message] of conversation.messages.entries()) {
                const snapshot = message.attempt?.scopeSnapshot;
                if (!snapshot) continue;
                const snapshotIds = new Set(snapshot.sourceIds);
                const snapshotVersions = new Map(
                  (snapshot.sourceVersions ?? []).map((item) => [item.sourceId, item.versionId]),
                );
                if (
                  snapshot.scope !== "cross-library-sources" ||
                  snapshot.spaceId !== "all" ||
                  snapshot.sourceId !== undefined ||
                  snapshot.selection !== undefined ||
                  snapshot.comparison !== undefined ||
                  snapshot.sourceIds.length !== conversation.sourceIds.length ||
                  snapshotIds.size !== ids.size ||
                  [...ids].some((sourceId) => !snapshotIds.has(sourceId)) ||
                  !snapshot.sourceVersions ||
                  snapshot.sourceVersions.length !== ids.size ||
                  fixedVersions.size !== ids.size ||
                  snapshotVersions.size !== ids.size ||
                  [...ids].some(
                    (sourceId) => snapshotVersions.get(sourceId) !== fixedVersions.get(sourceId),
                  )
                )
                  context.addIssue({
                    code: "custom",
                    path: ["messages", messageIndex, "attempt", "scopeSnapshot"],
                    message: "跨库会话的每次回答必须沿用同一份固定资料范围和版本。",
                  });
              }
            }
            const comparison = conversation.comparison;
            if (!comparison) return;
            if (conversation.scope !== "sources")
              context.addIssue({
                code: "custom",
                path: ["scope"],
                message: "对照会话只能使用指定资料范围。",
              });
            if (conversation.sourceId !== undefined)
              context.addIssue({
                code: "custom",
                path: ["sourceId"],
                message: "对照会话不能伪装为单份资料问答。",
              });
            const expected = [comparison.leftSourceId, comparison.rightSourceId];
            const actual = new Set(conversation.sourceIds);
            if (
              conversation.sourceIds.length !== 2 ||
              actual.size !== 2 ||
              expected.some((sourceId) => !actual.has(sourceId))
            )
              context.addIssue({
                code: "custom",
                path: ["sourceIds"],
                message: "对照会话的资料范围必须与保存的两份资料一致。",
              });

            const expectedVersions = new Map([
              [comparison.leftSourceId, comparison.leftVersionId],
              [comparison.rightSourceId, comparison.rightVersionId],
            ]);
            for (const [messageIndex, message] of conversation.messages.entries()) {
              const snapshot = message.attempt?.scopeSnapshot;
              if (!snapshot) continue;
              const snapshotIds = new Set(snapshot.sourceIds);
              const snapshotVersions = new Map(
                (snapshot.sourceVersions ?? []).map((item) => [item.sourceId, item.versionId]),
              );
              const snapshotComparison = snapshot.comparison;
              if (
                snapshot.scope !== "sources" ||
                snapshot.spaceId !== conversation.spaceId ||
                snapshot.sourceId !== undefined ||
                snapshot.selection !== undefined ||
                snapshot.sourceIds.length !== expected.length ||
                snapshotIds.size !== expected.length ||
                expected.some((sourceId) => !snapshotIds.has(sourceId)) ||
                !snapshot.sourceVersions ||
                snapshot.sourceVersions.length !== expectedVersions.size ||
                snapshotVersions.size !== expectedVersions.size ||
                [...expectedVersions].some(
                  ([sourceId, versionId]) => snapshotVersions.get(sourceId) !== versionId,
                ) ||
                snapshotComparison?.leftSourceId !== comparison.leftSourceId ||
                snapshotComparison.leftVersionId !== comparison.leftVersionId ||
                snapshotComparison.rightSourceId !== comparison.rightSourceId ||
                snapshotComparison.rightVersionId !== comparison.rightVersionId
              )
                context.addIssue({
                  code: "custom",
                  path: ["messages", messageIndex, "attempt", "scopeSnapshot"],
                  message: "对照会话的每次回答必须沿用同一对固定资料与版本。",
                });
            }
          }),
      )
      .max(5_000),
    aiEnabled: z.boolean(),
    semanticSearch: z.boolean().optional(),
    autoOrganize: z.boolean().optional(),
    importJobs: z.array(importJobSchema).max(1000).optional(),
    organizationJobs: z.array(organizationJobSchema).max(1000).optional(),
    conceptRelations: z.array(conceptRelationSchema).max(2000).optional(),
  })
  .strict()
  .superRefine((workspace, context) => {
    const sourceById = new Map<string, Source>();
    const duplicateSourceIds = new Set<string>();
    for (const source of workspace.sources) {
      if (sourceById.has(source.id)) duplicateSourceIds.add(source.id);
      else sourceById.set(source.id, source);
    }
    const annotationById = new Map<string, (typeof workspace.annotations)[number]>();
    const annotationSourceKeys = new Set<string>();
    const duplicateAnnotationIds = new Set<string>();
    for (const [annotationIndex, annotation] of workspace.annotations.entries()) {
      annotationSourceKeys.add(`${annotation.sourceId}\u0000${annotation.id}`);
      if (annotationById.has(annotation.id)) duplicateAnnotationIds.add(annotation.id);
      else annotationById.set(annotation.id, annotation);
      if (annotation.textAnchor !== undefined) {
        const source = sourceById.get(annotation.sourceId);
        const versions = source
          ? [source, ...(source.versions ?? [])].filter(
              (version) => version.versionId === annotation.versionId,
            )
          : [];
        if (
          duplicateSourceIds.has(annotation.sourceId) ||
          versions.length !== 1 ||
          !annotationTextAnchorMatches(versions[0].text, annotation)
        )
          context.addIssue({
            code: "custom",
            path: ["annotations", annotationIndex, "textAnchor"],
            message: "批注原文位置与保留资料版本不一致。",
          });
      }
    }
    const recoverableDraftIds = new Set<string>();
    for (const [draftIndex, draft] of (workspace.recoverableDrafts ?? []).entries()) {
      if (recoverableDraftIds.has(draft.id))
        context.addIssue({
          code: "custom",
          path: ["recoverableDrafts", draftIndex, "id"],
          message: "同一可恢复草稿不能重复保存。",
        });
      recoverableDraftIds.add(draft.id);

      const source = sourceById.get(draft.sourceId);
      const sourceVersionMatches =
        source &&
        (source.versionId === draft.sourceVersionId ||
          source.versions?.some((version) => version.versionId === draft.sourceVersionId));
      if (
        !source ||
        duplicateSourceIds.has(draft.sourceId) ||
        source.deletedAt !== draft.sourceDeletedAt ||
        source.title !== draft.sourceTitle ||
        !sourceVersionMatches
      )
        context.addIssue({
          code: "custom",
          path: ["recoverableDrafts", draftIndex, "sourceId"],
          message: "可恢复草稿必须绑定工作区中同一份已删除资料及其准确版本。",
        });

      const annotation = annotationById.get(draft.annotationId);
      if (
        !annotation ||
        duplicateAnnotationIds.has(draft.annotationId) ||
        annotation.sourceId !== draft.sourceId ||
        annotation.versionId !== draft.sourceVersionId ||
        annotation.createdAt !== draft.annotationCreatedAt ||
        annotation.quote !== draft.quote ||
        annotation.note !== draft.note ||
        annotation.page !== draft.page ||
        !sameAnnotationTextAnchor(annotation.textAnchor, draft.textAnchor)
      )
        context.addIssue({
          code: "custom",
          path: ["recoverableDrafts", draftIndex, "annotationId"],
          message: "可恢复草稿必须保留一份内容完全一致的原批注。",
        });
    }
    const resolvedRecoverableDraftIds = new Set<string>();
    for (const [markerIndex, marker] of (workspace.resolvedRecoverableDrafts ?? []).entries()) {
      if (resolvedRecoverableDraftIds.has(marker.id))
        context.addIssue({
          code: "custom",
          path: ["resolvedRecoverableDrafts", markerIndex, "id"],
          message: "同一已处理草稿标记不能重复保存。",
        });
      resolvedRecoverableDraftIds.add(marker.id);
      if (recoverableDraftIds.has(marker.id))
        context.addIssue({
          code: "custom",
          path: ["resolvedRecoverableDrafts", markerIndex, "id"],
          message: "可恢复草稿不能同时处于待处理和已处理状态。",
        });
      if (
        marker.annotationDisposition === "remove" &&
        annotationSourceKeys.has(`${marker.sourceId}\u0000${marker.annotationId}`)
      )
        context.addIssue({
          code: "custom",
          path: ["resolvedRecoverableDrafts", markerIndex, "annotationDisposition"],
          message: "要求移除原批注的已处理草稿标记不能与该批注同时保存。",
        });
    }
    const seenAnswerAttempts = new Set<string>();
    for (const [conversationIndex, conversation] of workspace.conversations.entries()) {
      const userMessageIds = new Set(
        conversation.messages
          .filter((message) => message.role === "user")
          .map((message) => message.id),
      );
      for (const [messageIndex, message] of conversation.messages.entries()) {
        const attempt = message.attempt;
        if (!attempt) continue;
        if (message.role !== "assistant")
          context.addIssue({
            code: "custom",
            path: ["conversations", conversationIndex, "messages", messageIndex, "attempt"],
            message: "回答尝试只能附在助手记录上。",
          });
        if (!userMessageIds.has(attempt.questionMessageId))
          context.addIssue({
            code: "custom",
            path: [
              "conversations",
              conversationIndex,
              "messages",
              messageIndex,
              "attempt",
              "questionMessageId",
            ],
            message: "回答尝试必须关联同一对话中已有的用户问题。",
          });
        if (seenAnswerAttempts.has(attempt.id))
          context.addIssue({
            code: "custom",
            path: ["conversations", conversationIndex, "messages", messageIndex, "attempt", "id"],
            message: "回答尝试身份不能重复。",
          });
        seenAnswerAttempts.add(attempt.id);
      }
    }
    const seenImports = new Set<string>();
    for (const [index, job] of (workspace.importJobs ?? []).entries()) {
      const source = workspace.sources.find((item) => item.id === job.sourceId);
      const hasVersion =
        source &&
        [source, ...(source.versions ?? [])].some((version) => version.versionId === job.versionId);
      if (!hasVersion)
        context.addIssue({
          code: "custom",
          path: ["importJobs", index, "sourceId"],
          message: "导入任务必须指向工作区中的准确资料版本。",
        });
      const identity = JSON.stringify([job.sourceId, job.versionId]);
      if (seenImports.has(identity))
        context.addIssue({
          code: "custom",
          path: ["importJobs", index],
          message: "同一资料版本不能有多个导入任务。",
        });
      seenImports.add(identity);
    }
  });

export const saveRequestSchema = z
  .object({
    data: workspaceSchema,
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
export const answerRequestSchema = z
  .object({
    requestId: id.optional(),
    conversationId: id.optional(),
    question: z.string().trim().min(1).max(4000),
    depth: z.enum(["standard", "deep"]).optional(),
    userContext: z
      .array(z.string().trim().min(1).max(ANSWER_USER_CONTEXT_ITEM_MAX_CHARS))
      .max(ANSWER_USER_CONTEXT_MAX_ITEMS)
      .optional(),
    scope: z.enum([
      "selection",
      "document",
      "document-notes",
      "sources",
      "space",
      "cross-library-sources",
    ]),
    sourceId: id.optional(),
    sourceIds: z.array(id).max(100),
    sourceVersions: z.array(sourceVersionReference).min(1).max(100).optional(),
    comparison: comparisonIdentity.optional(),
    spaceId: id,
    selection: z.string().max(20_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const singleSourceScope = isSingleSourceAnswerScope(value.scope);
    const userContext = value.userContext ?? [];
    if (
      userContext.reduce((length, item) => length + item.length, 0) > ANSWER_USER_CONTEXT_MAX_CHARS
    )
      context.addIssue({
        code: "custom",
        path: ["userContext"],
        message: "连续追问上下文超出允许范围。",
      });
    if ((value.scope === "sources" || singleSourceScope) && !value.sourceVersions)
      context.addIssue({
        code: "custom",
        path: ["sourceVersions"],
        message: singleSourceScope
          ? "单份资料问答必须锁定当前资料版本。"
          : "指定资料问答必须锁定每份资料的当前版本。",
      });
    if (value.sourceVersions) {
      const expectedIds = singleSourceScope
        ? value.sourceId
          ? [value.sourceId]
          : []
        : value.sourceIds;
      const expected = new Set(expectedIds);
      const actual = new Set(value.sourceVersions.map((item) => item.sourceId));
      if (
        value.scope === "space" ||
        expected.size !== expectedIds.length ||
        value.sourceVersions.length !== expected.size ||
        actual.size !== value.sourceVersions.length ||
        value.sourceVersions.some((item) => !expected.has(item.sourceId))
      )
        context.addIssue({
          code: "custom",
          path: ["sourceVersions"],
          message: "固定资料版本必须与指定资料范围一一对应。",
        });
    }
    if (value.scope === "cross-library-sources") {
      const ids = new Set(value.sourceIds);
      const versions = value.sourceVersions
        ? new Set(value.sourceVersions.map((item) => item.sourceId))
        : new Set<string>();
      if (
        value.spaceId !== "all" ||
        value.sourceId !== undefined ||
        value.selection !== undefined ||
        value.comparison !== undefined ||
        value.sourceIds.length < 1 ||
        value.sourceIds.length > 5 ||
        ids.size !== value.sourceIds.length ||
        !value.sourceVersions ||
        value.sourceVersions.length !== ids.size ||
        versions.size !== value.sourceVersions.length ||
        [...ids].some((sourceId) => !versions.has(sourceId))
      )
        context.addIssue({
          code: "custom",
          path: ["scope"],
          message: "跨库问答必须在全部资料库中锁定 1 至 5 份资料及其当前版本。",
        });
    }
    if (value.comparison) {
      const expectedSources = [value.comparison.leftSourceId, value.comparison.rightSourceId];
      const actualSources = new Set(value.sourceIds);
      const expectedVersions = new Map([
        [value.comparison.leftSourceId, value.comparison.leftVersionId],
        [value.comparison.rightSourceId, value.comparison.rightVersionId],
      ]);
      const actualVersions = new Map(
        (value.sourceVersions ?? []).map((item) => [item.sourceId, item.versionId]),
      );
      if (
        value.scope !== "sources" ||
        value.sourceId !== undefined ||
        value.selection !== undefined ||
        value.sourceIds.length !== 2 ||
        actualSources.size !== 2 ||
        expectedSources.some((sourceId) => !actualSources.has(sourceId)) ||
        !value.sourceVersions ||
        value.sourceVersions.length !== 2 ||
        actualVersions.size !== 2 ||
        [...expectedVersions].some(
          ([sourceId, versionId]) => actualVersions.get(sourceId) !== versionId,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["comparison"],
          message: "对照问答必须固定为保存的两份资料与版本。",
        });
    }
  });

export const answerResultSchema = z
  .object({
    content: z.string().min(1).max(50_000),
    citations: z.array(citation).max(12),
    noteEvidence: z.array(answerNoteEvidence).max(12).optional(),
    mode: z.enum(["extractive", "model"]),
  })
  .strict();

export function assertWorkspaceOwner(data: WorkspaceData, ownerId: string) {
  for (const source of data.sources) {
    if (
      [source, ...(source.versions ?? [])].some(
        (version) => version.storagePath && !version.storagePath.startsWith(`${ownerId}/`),
      )
    ) {
      throw new Error("资料的云端路径不属于当前账号。");
    }
  }
  for (const items of [
    data.spaces,
    data.sources,
    data.notes,
    data.annotations,
    data.recoverableDrafts ?? [],
    data.resolvedRecoverableDrafts ?? [],
    data.conversations,
    data.importJobs ?? [],
    data.organizationJobs ?? [],
    data.conceptRelations ?? [],
  ]) {
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error("数据包含重复标识，请保留本地副本后重新载入云端。");
  }
}
