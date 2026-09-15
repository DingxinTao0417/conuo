import {
  prepareKnowledgeUpdateWithdrawal,
  commitKnowledgeUpdateWithdrawal,
  type PreparedKnowledgeUpdateWithdrawal,
  type KnowledgeUpdateWithdrawalSelection,
} from "./knowledge-update-withdrawal";
import type { WorkspaceData } from "./types";

export interface KnowledgeUpdateWithdrawalOperationIdentity {
  token: number;
  userId: string | null;
  localCacheMode: string;
  noteId: string | null;
}

export interface KnowledgeUpdateWithdrawalOperationContext extends KnowledgeUpdateWithdrawalOperationIdentity {
  ready: boolean;
  data: WorkspaceData;
}

export interface PersistKnowledgeUpdateWithdrawalInput {
  getContext: () => KnowledgeUpdateWithdrawalOperationContext | null;
  expectedContext: KnowledgeUpdateWithdrawalOperationIdentity;
  jobId: string;
  fingerprint: string;
  selections: KnowledgeUpdateWithdrawalSelection[];
  updateDurably: (updater: (current: WorkspaceData) => WorkspaceData) => Promise<boolean>;
}

/** Resolution confirms this browser's durable save; cloud sync uses its own status. */
export async function persistKnowledgeUpdateWithdrawal({
  getContext,
  expectedContext,
  jobId,
  fingerprint,
  selections,
  updateDurably,
}: PersistKnowledgeUpdateWithdrawalInput): Promise<void> {
  // Event inputs belong to the reviewed context, even if their caller mutates them later.
  const identity = { ...expectedContext };
  const choices = selections.map((selection) => ({ ...selection }));
  const currentContext = () => {
    const current = getContext();
    if (
      !current?.ready ||
      !identity.noteId ||
      current.token !== identity.token ||
      current.userId !== identity.userId ||
      current.localCacheMode !== identity.localCacheMode ||
      current.noteId !== identity.noteId
    )
      throw new Error("当前账号、缓存模式或知识页已改变，请重新核对撤回范围。");
    return current;
  };
  const context = currentContext();
  let prepared: PreparedKnowledgeUpdateWithdrawal;
  try {
    prepared = await prepareKnowledgeUpdateWithdrawal(
      structuredClone(context.data),
      jobId,
      fingerprint,
      choices,
    );
  } catch (cause) {
    currentContext();
    throw cause;
  }
  currentContext();
  if (
    prepared.jobId !== jobId ||
    prepared.noteId !== identity.noteId ||
    prepared.fingerprint !== fingerprint
  )
    throw new Error("撤回范围与已核对的知识页不一致，请重新核对。");
  let applied: boolean;
  try {
    applied = await updateDurably((current) => {
      currentContext();
      // The synchronous commit checks the latest canonical note, including history and refs.
      return commitKnowledgeUpdateWithdrawal(current, prepared);
    });
  } catch (cause) {
    currentContext();
    throw cause;
  }
  currentContext();
  if (!applied) throw new Error("撤回未应用，请检查当前工作区状态后重新核对。");
}
