import { unified } from "unified";
import remarkParse from "remark-parse";
import rehypeParse from "rehype-parse";
import type { PreparedBackup, RestorePlan } from "./backup-types";
import type { Citation, Source, SourceVersion, WorkspaceData } from "./types";
import type { KnowledgeNoteSnapshot } from "./knowledge-update-types";
import type { OrganizationJob, OrganizationResult } from "./organization-types";
import type { RelationDraft } from "./concept-relation-types";
import { recoverableSourceAnnotationDraftId } from "./recoverable-drafts";
import {
  advanceImportJob,
  cancelImportJob,
  createImportJob,
  importJobId,
  startImportJob,
  type ImportJob,
} from "./import-queue";
import { MAX_WORKSPACE_BYTES, workspaceSchema } from "./supabase/validation";

const rootKeys = [
  "spaces",
  "sources",
  "notes",
  "annotations",
  "recoverableDrafts",
  "resolvedRecoverableDrafts",
  "conversations",
  "importJobs",
  "organizationJobs",
  "conceptRelations",
] as const;
const pair = (sourceId: string, versionId: string) => JSON.stringify([sourceId, versionId]);
const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
const restoredImportError = "从备份恢复时未继续解析。原文件已保存，可从导入记录重新解析。";
const missingImportError = "从备份恢复时未找到原文件，无法继续解析。请重新选择原文件后再导入。";
const markdown = unified().use(remarkParse);
const html = unified().use(rehypeParse, { fragment: true });
type TreeNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  url?: string;
  value?: string;
  children?: TreeNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

function validateWorkspace(data: WorkspaceData) {
  if (!workspaceSchema.safeParse(data).success)
    throw new Error("备份或工作区数据格式无效，未修改已有资料。");
  for (const key of rootKeys) {
    const items = data[key] ?? [];
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error("备份或工作区包含重复对象标识，未修改已有资料。");
  }
  // The shared schema's historic checks do not run on sources without history.
  // Validate every current and retained chunk against its exact source/version.
  for (const source of data.sources) {
    const versions = [source, ...(source.versions ?? [])];
    if (new Set(versions.map((version) => version.versionId)).size !== versions.length)
      throw new Error("备份包含重复资料版本，无法确定原件及引用归属。");
    for (const version of versions) {
      if (
        new Set(version.chunks.map((chunk) => chunk.id)).size !== version.chunks.length ||
        version.chunks.some(
          (chunk) =>
            chunk.sourceId !== source.id ||
            chunk.versionId !== version.versionId ||
            !chunk.text.trim() ||
            !version.text.includes(chunk.text),
        )
      )
        throw new Error("备份的资料片段与准确版本不一致，未修改已有资料。");
    }
  }
}

/** Replace only destinations recognized by Markdown/HTML parsers; never replace prose, code or quotes. */
function rewriteLinks(content: string, destination: (href: string) => string): string {
  const edits: { start: number; end: number; text: string }[] = [];
  function htmlLinks(fragment: string, offset: number) {
    function visit(node: TreeNode) {
      if (["code", "pre", "script", "style", "textarea"].includes(node.tagName ?? "")) return;
      if (node.tagName === "a" && typeof node.properties?.href === "string") {
        const href = node.properties.href;
        const next = destination(href);
        const start = node.position?.start.offset;
        if (next !== href && start !== undefined) {
          // Scan the parser-identified opening tag, honoring quoted '>' and all
          // attribute boundaries. A data-* value containing 'href=' is not a link.
          let end = start,
            quote = "";
          for (; end < fragment.length; end++) {
            const char = fragment[end];
            if (quote) {
              if (char === quote) quote = "";
            } else if (char === '"' || char === "'") quote = char;
            else if (char === ">") break;
          }
          const opening = fragment.slice(start, end);
          const attributes = /([^\s=<>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
          for (const match of opening.matchAll(attributes)) {
            if (match[1].toLowerCase() !== "href" || !match[0].includes("=")) continue;
            const equal = match[0].indexOf("=");
            const tail = match[0].slice(equal + 1);
            const whitespace = tail.length - tail.trimStart().length;
            const valueStart = equal + 1 + whitespace;
            const quoted = ['"', "'"].includes(match[0][valueStart]);
            edits.push({
              start: offset + start + match.index! + valueStart + Number(quoted),
              end: offset + start + match.index! + match[0].length - Number(quoted),
              text: next,
            });
            break;
          }
        }
      }
      node.children?.forEach(visit);
    }
    visit(html.parse(fragment) as TreeNode);
  }
  function visit(node: TreeNode) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "html" && start !== undefined && typeof node.value === "string") {
      htmlLinks(node.value, start);
      return;
    }
    if (
      (node.type === "link" || node.type === "definition") &&
      node.url &&
      start !== undefined &&
      end !== undefined
    ) {
      const next = destination(node.url);
      if (next !== node.url) {
        const fragment = content.slice(start, end);
        const pattern =
          node.type === "definition"
            ? /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>\r\n]*)>|([^\s]+))/g
            : /\]\(\s*(?:<([^>\r\n]*)>|([^\s)]*))/g;
        const matches = [...fragment.matchAll(pattern)];
        const match = matches.at(-1);
        if (!match) throw new Error("备份中的内部链接无法安全重绑定，请保留原备份并检查正文。");
        const raw = match[1] ?? match[2];
        const at = match.index! + match[0].lastIndexOf(raw);
        edits.push({ start: start + at, end: start + at + raw.length, text: next });
      }
    }
    if (node.type !== "code" && node.type !== "inlineCode") node.children?.forEach(visit);
  }
  visit(markdown.parse(content) as TreeNode);
  let result = content,
    last = content.length;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > last) throw new Error("备份中的内部链接重叠，未修改已有资料。");
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    last = edit.start;
  }
  return result;
}

export function prepareBackupRestore(backup: PreparedBackup): RestorePlan {
  validateWorkspace(backup.data);
  if (!/^[a-f0-9]{64}$/.test(backup.fingerprint)) throw new Error("备份指纹无效。");
  const mappings = new Map<string, string>();
  const allocated = new Set<string>();
  function fresh() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = crypto.randomUUID();
      if (identifier.test(id) && !allocated.has(id)) {
        allocated.add(id);
        return id;
      }
    }
    throw new Error("无法生成独立恢复标识，请重试；已有资料未修改。");
  }
  const planId = fresh();
  function map(kind: string, ...parts: string[]) {
    const key = JSON.stringify([kind, ...parts]);
    if (!mappings.has(key)) mappings.set(key, fresh());
    return mappings.get(key)!;
  }
  const knownSpaces = new Set(backup.data.spaces.map((space) => space.id));
  const spaceId = (id: string) =>
    !knownSpaces.has(id) && ["inbox", "all"].includes(id) ? id : map("space", id);
  const sourceId = (id: string) => map("source", id);
  const versionId = (sid: string, vid: string) => map("version", sid, vid);
  const noteId = (id: string) => map("note", id);
  const proposalId = (job: string, id: string) => map("proposal", job, id);
  const changeId = (job: string, id: string) => map("change", job, id);
  const linkWarnings = new Set<string>();
  function href(value: string) {
    const target = value.trim();
    const local = target.match(/^(\/?|\.\/)#(source|note|library|conversation)\/([^/]+)(.*)$/);
    if (!local) {
      if (/^https?:\/\/.+#(?:source|note|library|conversation)\//i.test(target))
        linkWarnings.add(
          "部分绝对网址仍指向原应用地址，未自动改写到本机副本，请核对这些外部链接。",
        );
      return value;
    }
    const [, prefix, kind, id, suffix] = local;
    if (!identifier.test(id)) {
      linkWarnings.add("部分内部链接标识无效，已停止其跳转；链接文字仍保留。");
      return "#backup-link-unavailable";
    }
    if (kind === "source") {
      const version = suffix.match(/^\/version\/([^/]+)(.*)$/);
      if (version && !identifier.test(version[1])) {
        linkWarnings.add("部分内部版本链接标识无效，已停止其跳转；链接文字仍保留。");
        return "#backup-link-unavailable";
      }
      return `${prefix}#source/${sourceId(id)}${version ? `/version/${versionId(id, version[1])}${version[2]}` : suffix}`;
    }
    if (kind === "note") return `${prefix}#note/${noteId(id)}${suffix}`;
    if (kind === "library") return `${prefix}#library/${spaceId(id)}${suffix}`;
    return `${prefix}#conversation/${map("conversation", id)}${suffix}`;
  }
  const content = (text: string) => rewriteLinks(text, href);
  const citations = (items: Citation[]) =>
    items.map((item) => ({
      ...item,
      sourceId: sourceId(item.sourceId),
      versionId: versionId(item.sourceId, item.versionId),
      chunkId: map("chunk", item.sourceId, item.versionId, item.chunkId),
    }));
  const manualExcerptRefs = <T extends { sourceId: string; versionId: string; chunkId: string }>(
    items: T[] | undefined,
  ) =>
    items?.map((item) => ({
      ...item,
      sourceId: sourceId(item.sourceId),
      versionId: versionId(item.sourceId, item.versionId),
      chunkId: map("chunk", item.sourceId, item.versionId, item.chunkId),
    }));
  const snapshot = (item: KnowledgeNoteSnapshot): KnowledgeNoteSnapshot => ({
    ...item,
    id: noteId(item.id),
    spaceId: spaceId(item.spaceId),
    content: content(item.content),
    citations: citations(item.citations),
  });
  const draft = <T extends RelationDraft>(item: T): T => ({
    ...item,
    fromCitations: citations(item.fromCitations),
    toCitations: citations(item.toCitations),
  });
  const originalByVersion = new Map<string, Blob>();
  const missingByVersion = new Map<string, PreparedBackup["missingOriginals"][number]>();
  const exactVersions = new Map<string, Source | SourceVersion>();
  for (const source of backup.data.sources)
    for (const version of [source, ...(source.versions ?? [])])
      exactVersions.set(pair(source.id, version.versionId), version);
  for (const item of backup.originals) {
    const key = pair(item.sourceId, item.versionId);
    const version = exactVersions.get(key);
    if (
      !version ||
      originalByVersion.has(key) ||
      !(item.blob instanceof Blob) ||
      item.blob.size !== version.size
    )
      throw new Error("备份原件与资料版本不一致。");
    originalByVersion.set(key, item.blob);
  }
  for (const item of backup.missingOriginals) {
    const key = pair(item.sourceId, item.versionId);
    if (!exactVersions.has(key) || missingByVersion.has(key) || originalByVersion.has(key))
      throw new Error("备份的原件缺失清单与准确版本不一致。");
    missingByVersion.set(key, item);
  }
  for (const [key, value] of exactVersions) {
    if (
      !originalByVersion.has(key) &&
      !missingByVersion.has(key) &&
      (value.originalMissing || value.blobKey || value.storagePath)
    ) {
      const [sourceId, versionId] = JSON.parse(key) as [string, string];
      missingByVersion.set(key, {
        sourceId,
        versionId,
        title: value.title,
        filename: value.filename,
      });
    }
  }
  const blobs: RestorePlan["blobs"] = [];
  function version<T extends Source | SourceVersion>(sid: string, value: T): T {
    const next = {
      ...value,
      versionId: versionId(sid, value.versionId),
      chunks: value.chunks.map((chunk) => ({
        ...chunk,
        sourceId: sourceId(sid),
        versionId: versionId(sid, value.versionId),
        id: map("chunk", sid, value.versionId, chunk.id),
      })),
    };
    delete next.storagePath;
    delete next.blobKey;
    const key = pair(sid, value.versionId);
    const blob = originalByVersion.get(key);
    if (blob) {
      next.blobKey = `original:${sourceId(sid)}:${next.versionId}`;
      delete next.originalMissing;
      blobs.push({ key: next.blobKey!, blob, sourceId: sourceId(sid), versionId: next.versionId });
    } else if (missingByVersion.has(key)) next.originalMissing = true;
    return next;
  }
  function result(value: OrganizationResult, jobId: string): OrganizationResult {
    if (value.kind === "source")
      return {
        ...value,
        summary: {
          ...value.summary,
          content: content(value.summary.content),
          citations: citations(value.summary.citations),
        },
        tags: value.tags.map((tag) => ({ ...tag, citations: citations(tag.citations) })),
        topics: value.topics.map((topic) => ({ ...topic, citations: citations(topic.citations) })),
      };
    if (value.kind === "knowledge")
      return {
        ...value,
        pages: value.pages.map((page) => ({
          ...page,
          content: content(page.content),
          citations: citations(page.citations),
        })),
      };
    if (value.kind === "update")
      return {
        ...value,
        target: snapshot(value.target),
        changes: value.changes.map((change) => ({
          ...change,
          id: changeId(jobId, change.id),
          before: content(change.before),
          citations: citations(change.citations),
        })),
      };
    return {
      ...value,
      target: snapshot(value.target),
      compare: snapshot(value.compare),
      relations: value.relations.map((item) => ({
        ...draft(item),
        id: proposalId(jobId, item.id),
      })),
    };
  }
  function job(value: OrganizationJob): OrganizationJob {
    const next: OrganizationJob = {
      ...structuredClone(value),
      id: map("job", value.id),
      restoredFromBackup: true,
      status: value.status === "queued" || value.status === "running" ? "cancelled" : value.status,
      request: {
        ...value.request,
        requestId: map("job", value.id),
        spaceId: spaceId(value.request.spaceId),
        sourceIds: value.request.sourceIds.map(sourceId),
        sourceVersions: value.request.sourceVersions.map((item) => ({
          sourceId: sourceId(item.sourceId),
          versionId: versionId(item.sourceId, item.versionId),
        })),
      },
    };
    if (value.request.targetNote)
      next.request.targetNote = {
        ...value.request.targetNote,
        id: noteId(value.request.targetNote.id),
      };
    if (value.request.compareNote)
      next.request.compareNote = {
        ...value.request.compareNote,
        id: noteId(value.request.compareNote.id),
      };
    if (value.result) next.result = result(value.result, value.id);
    if (value.savedPages)
      next.savedPages = value.savedPages.map((item) => ({ ...item, noteId: noteId(item.noteId) }));
    if (value.savedRelations)
      next.savedRelations = value.savedRelations.map((item) => ({
        proposalId: proposalId(value.id, item.proposalId),
        relationId: map("relation", item.relationId),
      }));
    if (value.ignoredRelations)
      next.ignoredRelations = value.ignoredRelations.map((id) => proposalId(value.id, id));
    if (value.updateReview)
      next.updateReview = {
        note: snapshot(value.updateReview.note),
        applied: value.updateReview.applied.map((item) => ({
          ...item,
          changeId: changeId(value.id, item.changeId),
        })),
        ignored: value.updateReview.ignored.map((id) => changeId(value.id, id)),
        ...(value.updateReview.withdrawal
          ? {
              withdrawal: {
                ...value.updateReview.withdrawal,
                id: map("withdrawal", value.id, value.updateReview.withdrawal.id),
                restoredChangeIds: value.updateReview.withdrawal.restoredChangeIds.map((id) =>
                  changeId(value.id, id),
                ),
                keptChangeIds: value.updateReview.withdrawal.keptChangeIds.map((id) =>
                  changeId(value.id, id),
                ),
                // This is evidence for the original confirmed context, not authorization
                // to replay operations against the independently remapped backup copy.
              },
            }
          : {}),
      };
    return next;
  }
  const restoredSources = backup.data.sources.map((item) => ({
    ...version(item.id, item),
    id: sourceId(item.id),
    aiAllowed: false,
    spaceIds: item.spaceIds.map(spaceId),
    ...(item.versions ? { versions: item.versions.map((old) => version(item.id, old)) } : {}),
  }));
  const sourceByOldId = new Map(backup.data.sources.map((item) => [item.id, item]));
  const restoredSourceById = new Map(restoredSources.map((item) => [item.id, item]));
  const importJobs: ImportJob[] = [];
  const importWarnings = new Set<string>();
  const importSpaceId = (id: string) => (id && knownSpaces.has(id) ? spaceId(id) : "");
  function restoreImportJob(value: ImportJob, source: Source): ImportJob {
    let next = createImportJob({
      sourceId: source.id,
      versionId: source.versionId,
      filename: source.filename,
      spaceId: importSpaceId(value.spaceId),
      at: value.createdAt,
    });
    next = startImportJob(next, value.updatedAt);
    next = advanceImportJob(next, "parsing", value.updatedAt);
    return cancelImportJob(next, value.updatedAt);
  }
  for (const value of backup.data.importJobs ?? []) {
    const original = sourceByOldId.get(value.sourceId);
    const source = original && restoredSourceById.get(sourceId(original.id));
    // A local import can only resume its current file version. If a file has
    // since been replaced, leave the newer current version untouched instead
    // of presenting a retry action that could parse the wrong bytes.
    if (
      !original ||
      !source ||
      original.versionId !== value.versionId ||
      source.versionId !== versionId(original.id, original.versionId) ||
      original.kind === "web"
    ) {
      importWarnings.add("部分导入记录未绑定到当前文件版本，未恢复该记录，也不会自动续跑。");
      continue;
    }
    if (value.status === "completed") {
      importJobs.push({
        ...structuredClone(value),
        id: importJobId(source.id, source.versionId),
        sourceId: source.id,
        versionId: source.versionId,
        filename: source.filename,
        spaceId: importSpaceId(value.spaceId),
      });
      continue;
    }
    if (originalByVersion.has(pair(original.id, original.versionId))) {
      source.status = "saved";
      source.text = "";
      source.chunks = [];
      source.error = restoredImportError;
      source.updatedAt = value.updatedAt;
      source.coverage = { captureScope: "full", parseState: "pending" };
      delete source.pageCount;
      delete source.parsedPages;
      delete source.originalMissing;
      importJobs.push(restoreImportJob(value, source));
      importWarnings.add("备份中的未完成导入已停止；原文件存在的资料可从导入记录重新解析。");
      continue;
    }
    const originalKey = pair(original.id, original.versionId);
    if (!missingByVersion.has(originalKey))
      missingByVersion.set(originalKey, {
        sourceId: original.id,
        versionId: original.versionId,
        title: original.title,
        filename: original.filename,
        reason: "未完成导入的原文件未包含在备份中，无法继续解析。",
      });
    source.status = "failed";
    source.text = "";
    source.chunks = [];
    source.error = missingImportError;
    source.originalMissing = true;
    source.updatedAt = value.updatedAt;
    source.coverage = { captureScope: "full", parseState: "failed" };
    delete source.pageCount;
    delete source.parsedPages;
    importWarnings.add("部分未完成导入的原文件未包含在备份中，已标记为解析失败。");
  }
  const data: WorkspaceData = {
    schemaVersion: 1,
    aiEnabled: false,
    semanticSearch: false,
    autoOrganize: false,
    spaces: backup.data.spaces.map((item) => ({ ...item, id: spaceId(item.id) })),
    sources: restoredSources,
    notes: backup.data.notes.map((item) => ({
      ...item,
      id: noteId(item.id),
      spaceId: spaceId(item.spaceId),
      content: content(item.content),
      citations: citations(item.citations),
      ...(item.manualExcerptRefs !== undefined
        ? { manualExcerptRefs: manualExcerptRefs(item.manualExcerptRefs) }
        : {}),
      versions: item.versions.map((old, index) => ({
        ...old,
        id: map("note-version", item.id, old.id, String(index)),
        content: content(old.content),
        ...(old.citations ? { citations: citations(old.citations) } : {}),
        ...(old.manualExcerptRefs !== undefined
          ? { manualExcerptRefs: manualExcerptRefs(old.manualExcerptRefs) }
          : {}),
        ...(old.spaceId !== undefined ? { spaceId: spaceId(old.spaceId) } : {}),
      })),
    })),
    annotations: backup.data.annotations.map((item) => ({
      ...item,
      id: map("annotation", item.id),
      sourceId: sourceId(item.sourceId),
      versionId: versionId(item.sourceId, item.versionId),
    })),
    ...(backup.data.recoverableDrafts !== undefined
      ? {
          recoverableDrafts: backup.data.recoverableDrafts.map((item) => {
            const restoredAnnotationId = map("annotation", item.annotationId);
            return {
              ...item,
              id: recoverableSourceAnnotationDraftId(restoredAnnotationId, item.sourceDeletedAt),
              sourceId: sourceId(item.sourceId),
              sourceVersionId: versionId(item.sourceId, item.sourceVersionId),
              annotationId: restoredAnnotationId,
            };
          }),
        }
      : {}),
    ...(backup.data.resolvedRecoverableDrafts !== undefined
      ? {
          resolvedRecoverableDrafts: backup.data.resolvedRecoverableDrafts.map((item) => {
            const restoredAnnotationId = map("annotation", item.annotationId);
            return {
              ...item,
              id: recoverableSourceAnnotationDraftId(restoredAnnotationId, item.sourceDeletedAt),
              sourceId: sourceId(item.sourceId),
              annotationId: restoredAnnotationId,
            };
          }),
        }
      : {}),
    conversations: backup.data.conversations.map((item) => {
      const messageIds = new Map(
        item.messages.map((message, index) => [
          message.id,
          map("message", item.id, message.id, String(index)),
        ]),
      );
      return {
        ...item,
        id: map("conversation", item.id),
        spaceId: spaceId(item.spaceId),
        ...(item.sourceId !== undefined ? { sourceId: sourceId(item.sourceId) } : {}),
        sourceIds: item.sourceIds.map(sourceId),
        ...(item.comparison
          ? {
              comparison: {
                leftSourceId: sourceId(item.comparison.leftSourceId),
                leftVersionId: versionId(
                  item.comparison.leftSourceId,
                  item.comparison.leftVersionId,
                ),
                rightSourceId: sourceId(item.comparison.rightSourceId),
                rightVersionId: versionId(
                  item.comparison.rightSourceId,
                  item.comparison.rightVersionId,
                ),
              },
            }
          : {}),
        messages: item.messages.map((message) => ({
          ...message,
          id: messageIds.get(message.id)!,
          content: content(message.content),
          citations: citations(message.citations),
          ...(message.noteEvidence
            ? {
                noteEvidence: message.noteEvidence.map((evidence) => ({
                  ...evidence,
                  noteId: noteId(evidence.noteId),
                  spaceId: spaceId(evidence.spaceId),
                  sourceId: sourceId(evidence.sourceId),
                  sourceVersionId: versionId(evidence.sourceId, evidence.sourceVersionId),
                })),
              }
            : {}),
          ...(message.attempt
            ? {
                attempt: {
                  ...message.attempt,
                  // A restored answer must never reuse an old cloud request
                  // ledger identity, even when it is only displayed as history.
                  id: map("answer-attempt", item.id, message.id, message.attempt.id),
                  questionMessageId:
                    messageIds.get(message.attempt.questionMessageId) ??
                    message.attempt.questionMessageId,
                  scopeSnapshot: {
                    ...message.attempt.scopeSnapshot,
                    ...(message.attempt.scopeSnapshot.sourceId !== undefined
                      ? { sourceId: sourceId(message.attempt.scopeSnapshot.sourceId) }
                      : {}),
                    sourceIds: message.attempt.scopeSnapshot.sourceIds.map(sourceId),
                    ...(message.attempt.scopeSnapshot.sourceVersions
                      ? {
                          sourceVersions: message.attempt.scopeSnapshot.sourceVersions.map(
                            (reference) => ({
                              sourceId: sourceId(reference.sourceId),
                              versionId: versionId(reference.sourceId, reference.versionId),
                            }),
                          ),
                        }
                      : {}),
                    ...(message.attempt.scopeSnapshot.comparison
                      ? {
                          comparison: {
                            leftSourceId: sourceId(
                              message.attempt.scopeSnapshot.comparison.leftSourceId,
                            ),
                            leftVersionId: versionId(
                              message.attempt.scopeSnapshot.comparison.leftSourceId,
                              message.attempt.scopeSnapshot.comparison.leftVersionId,
                            ),
                            rightSourceId: sourceId(
                              message.attempt.scopeSnapshot.comparison.rightSourceId,
                            ),
                            rightVersionId: versionId(
                              message.attempt.scopeSnapshot.comparison.rightSourceId,
                              message.attempt.scopeSnapshot.comparison.rightVersionId,
                            ),
                          },
                        }
                      : {}),
                    spaceId: spaceId(message.attempt.scopeSnapshot.spaceId),
                    ...(message.attempt.scopeSnapshot.selection !== undefined
                      ? { selection: content(message.attempt.scopeSnapshot.selection) }
                      : {}),
                    ...(message.attempt.scopeSnapshot.userContext
                      ? {
                          userContext: message.attempt.scopeSnapshot.userContext.map(content),
                        }
                      : {}),
                  },
                },
              }
            : {}),
        })),
      };
    }),
    ...(backup.data.importJobs ? { importJobs } : {}),
    ...(backup.data.organizationJobs
      ? { organizationJobs: backup.data.organizationJobs.map(job) }
      : {}),
    ...(backup.data.conceptRelations
      ? {
          conceptRelations: backup.data.conceptRelations.map((item) => ({
            ...draft(item),
            id: map("relation", item.id),
            spaceId: spaceId(item.spaceId),
            from: snapshot(item.from),
            to: snapshot(item.to),
            ...(item.jobId !== undefined ? { jobId: map("job", item.jobId) } : {}),
            ...(item.proposalId !== undefined
              ? { proposalId: proposalId(item.jobId ?? `relation:${item.id}`, item.proposalId) }
              : {}),
          })),
        }
      : {}),
  };
  const plan: RestorePlan = {
    id: planId,
    fingerprint: backup.fingerprint,
    data: structuredClone(data),
    blobs,
    missingOriginals: [...missingByVersion.values()].map((item) => ({
      ...item,
      sourceId: sourceId(item.sourceId),
      versionId: versionId(item.sourceId, item.versionId),
    })),
    counts: {
      spaces: data.spaces.length,
      sources: data.sources.length,
      sourceVersions: data.sources.reduce((sum, item) => sum + (item.versions?.length ?? 0), 0),
      notes: data.notes.length,
      noteVersions: data.notes.reduce((sum, item) => sum + item.versions.length, 0),
      conversations: data.conversations.length,
      messages: data.conversations.reduce((sum, item) => sum + item.messages.length, 0),
      annotations: data.annotations.length,
      recoverableDrafts: data.recoverableDrafts?.length ?? 0,
      organizationJobs: data.organizationJobs?.length ?? 0,
      conceptRelations: data.conceptRelations?.length ?? 0,
    },
    warnings: [
      ...(backup.warnings ?? []),
      ...linkWarnings,
      "恢复为新增副本；已有资料及全局 AI 设置保持不变。恢复资料默认关闭 AI。",
      ...(backup.data.organizationJobs?.some((item) => ["queued", "running"].includes(item.status))
        ? ["备份中的排队和运行任务已改为取消；结果与审核记录保留，不会自动续跑。"]
        : []),
      ...importWarnings,
    ],
  };
  validatePlan(plan);
  return plan;
}

function validatePlan(plan: RestorePlan) {
  validateWorkspace(plan.data);
  const versions = new Map<string, Source | SourceVersion>();
  for (const source of plan.data.sources) {
    if (source.aiAllowed) throw new Error("恢复资料必须先关闭 AI，确认后可逐份开启。");
    for (const version of [source, ...(source.versions ?? [])]) {
      if (
        version.storagePath !== undefined ||
        (version.blobKey !== undefined &&
          version.blobKey !== `original:${source.id}:${version.versionId}`)
      )
        throw new Error("恢复原件必须使用新的本机身份，不允许沿用云端路径。");
      versions.set(pair(source.id, version.versionId), version);
    }
  }
  if (plan.data.organizationJobs?.some((item) => ["queued", "running"].includes(item.status)))
    throw new Error("恢复计划不允许自动继续备份中的模型任务。");
  if (plan.data.organizationJobs?.some((item) => item.restoredFromBackup !== true))
    throw new Error("恢复任务缺少备份标记，不能将新身份误当作旧云端请求。");
  const currentSources = new Map(
    plan.data.sources.map((source) => [pair(source.id, source.versionId), source]),
  );
  for (const item of plan.data.importJobs ?? []) {
    const source = currentSources.get(pair(item.sourceId, item.versionId));
    if (!source || source.kind === "web")
      throw new Error("恢复导入记录没有对应的当前文件版本，不能提供不确定的重试操作。");
    if (item.status === "queued" || item.status === "running")
      throw new Error("恢复计划不允许自动继续备份中的文件导入。");
    if (item.status === "cancelled") {
      if (
        !item.originalSaved ||
        item.stage !== "parsing" ||
        !item.cancelledAt ||
        source.status !== "saved" ||
        source.text ||
        source.chunks.length ||
        source.error !== restoredImportError ||
        source.originalMissing ||
        !source.blobKey
      )
        throw new Error("恢复的文件导入必须保留原件并等待用户重新解析。");
      continue;
    }
    if (
      item.status !== "completed" ||
      !["ready", "partial"].includes(source.status) ||
      source.versionId !== item.versionId
    )
      throw new Error("恢复计划包含不完整的文件导入记录，不能继续使用。");
  }
  const seen = new Set<string>();
  for (const item of plan.blobs) {
    const value = versions.get(pair(item.sourceId, item.versionId));
    if (
      !value ||
      value.blobKey !== item.key ||
      seen.has(item.key) ||
      !(item.blob instanceof Blob) ||
      item.blob.size !== value.size
    )
      throw new Error("恢复原件清单无效，未修改已有资料。");
    seen.add(item.key);
  }
  const missing = new Set<string>();
  for (const item of plan.missingOriginals) {
    const key = pair(item.sourceId, item.versionId),
      value = versions.get(key);
    if (
      !value ||
      value.originalMissing !== true ||
      value.blobKey ||
      value.storagePath ||
      missing.has(key)
    )
      throw new Error("恢复原件缺失清单无效。");
    missing.add(key);
  }
  for (const [key, value] of versions) {
    if (
      (value.blobKey && !seen.has(value.blobKey)) ||
      (value.originalMissing && (!missing.has(key) || value.blobKey))
    )
      throw new Error("恢复原件或缺失清单不完整，未修改已有资料。");
  }
}

/** Append one prepared copy. Reapplying it never overwrites edits or revives partly deleted copies. */
export function mergeBackupRestore(current: WorkspaceData, plan: RestorePlan): WorkspaceData {
  validateWorkspace(current);
  validatePlan(plan);
  let total = 0,
    existing = 0;
  for (const key of rootKeys) {
    const ids = new Set((current[key] ?? []).map((item) => item.id));
    for (const item of plan.data[key] ?? []) {
      total++;
      if (ids.has(item.id)) existing++;
    }
  }
  if (total === 0 || existing === total) return current;
  if (existing) throw new Error("这份恢复副本已部分存在或已被修改，请勿重复并入同一计划。");
  const currentOriginals = new Set(
    current.sources.flatMap((source) =>
      [source, ...(source.versions ?? [])].flatMap((version) =>
        version.blobKey ? [version.blobKey] : [],
      ),
    ),
  );
  if (plan.blobs.some((item) => currentOriginals.has(item.key)))
    throw new Error("恢复原件标识已被现有资料使用，请重新准备独立副本。");
  const next: WorkspaceData = {
    ...current,
    spaces: [...current.spaces, ...structuredClone(plan.data.spaces)],
    sources: [...current.sources, ...structuredClone(plan.data.sources)],
    notes: [...current.notes, ...structuredClone(plan.data.notes)],
    annotations: [...current.annotations, ...structuredClone(plan.data.annotations)],
    ...(plan.data.recoverableDrafts?.length
      ? {
          recoverableDrafts: [
            ...(current.recoverableDrafts ?? []),
            ...structuredClone(plan.data.recoverableDrafts),
          ],
        }
      : {}),
    ...(plan.data.resolvedRecoverableDrafts?.length
      ? {
          resolvedRecoverableDrafts: [
            ...(current.resolvedRecoverableDrafts ?? []),
            ...structuredClone(plan.data.resolvedRecoverableDrafts),
          ],
        }
      : {}),
    conversations: [...current.conversations, ...structuredClone(plan.data.conversations)],
    ...(plan.data.importJobs?.length
      ? { importJobs: [...(current.importJobs ?? []), ...structuredClone(plan.data.importJobs)] }
      : {}),
    ...(plan.data.organizationJobs?.length
      ? {
          organizationJobs: [
            ...(current.organizationJobs ?? []),
            ...structuredClone(plan.data.organizationJobs),
          ],
        }
      : {}),
    ...(plan.data.conceptRelations?.length
      ? {
          conceptRelations: [
            ...(current.conceptRelations ?? []),
            ...structuredClone(plan.data.conceptRelations),
          ],
        }
      : {}),
  };
  validateWorkspace(next);
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_WORKSPACE_BYTES)
    throw new Error("并入完整备份后会超过工作区 3 MiB 容量；未删减历史或修改已有资料。");
  return next;
}

/**
 * Keeps a restore additive while making its active-space projection fit the
 * account's current quota. Existing spaces are never archived here: a
 * downgrade must remain editable, and only incoming restore copies are
 * demoted before the first save attempt.
 */
export function archiveExcessRestoreSpaces(
  current: WorkspaceData,
  plan: RestorePlan,
  limit: number,
): number {
  if (!Number.isInteger(limit) || limit < 1) return 0;
  let remaining = Math.max(0, limit - current.spaces.filter((space) => !space.archived).length);
  let archived = 0;
  const spaces = plan.data.spaces.map((space) => {
    if (space.archived || remaining > 0) {
      if (!space.archived) remaining -= 1;
      return space;
    }
    archived += 1;
    return { ...space, archived: true };
  });
  if (!archived) return 0;
  plan.data = { ...plan.data, spaces };
  plan.archivedSpaceCount = (plan.archivedSpaceCount ?? 0) + archived;
  plan.warnings = [
    ...plan.warnings,
    `当前账号的活跃学习空间额度不足，已将恢复副本中的 ${archived} 个空间转为归档；资料和笔记仍然保留。`,
  ];
  return archived;
}
