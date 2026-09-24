import type { AnswerRequest, WorkspaceData } from "../../src/lib/types";
import type { EvalCase } from "./dataset";

export function toAnswerRequest(data: WorkspaceData, item: EvalCase): AnswerRequest {
  const scope = item.scope;
  const docs =
    scope.type === "document" || scope.type === "selection"
      ? [scope.doc]
      : scope.type === "sources"
        ? scope.docs
        : [];
  const sources = docs
    .map((doc) => data.sources.find((source) => source.id === `src-${doc}`))
    .filter(Boolean);
  if (scope.type === "space") {
    return {
      requestId: `eval-${item.id}`,
      question: item.question,
      userContext: item.userContext,
      scope: "space",
      sourceIds: [],
      spaceId: `space-${scope.space}`,
    };
  }
  if (sources.length !== docs.length) throw new Error(`Unknown evaluation document in ${item.id}`);
  const first = sources[0]!;
  const request: AnswerRequest = {
    requestId: `eval-${item.id}`,
    question: item.question,
    userContext: item.userContext,
    scope:
      scope.type === "selection" ? "selection" : scope.type === "sources" ? "sources" : "document",
    sourceId: first.id,
    sourceIds: sources.map((source) => source!.id),
    sourceVersions: sources.map((source) => ({
      sourceId: source!.id,
      versionId: source!.versionId,
    })),
    spaceId: first.spaceIds[0]!,
    ...(scope.type === "selection" ? { selection: scope.selection } : {}),
  };
  return request;
}
