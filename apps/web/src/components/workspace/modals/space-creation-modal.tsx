"use client";
import Modal from "../../modal";
import { isUntouchedStarterWorkspace } from "../shared";
import type { WorkspaceData } from "@/lib/types";
import type { WorkspaceStore } from "../types";

export type SpaceCreationIntent = "browse" | "import";

export type SpaceCreationModalProps = {
  spaceCreationIntent: SpaceCreationIntent;
  data: WorkspaceData;
  update: WorkspaceStore["update"];
  setToast: (message: string) => void;
  setSpaceCreationIntent: (intent: SpaceCreationIntent) => void;
  setImportTargetSpaceId: (spaceId: string) => void;
  setModal: (modal: "import" | null) => void;
  ensureCanActivateSpace?: (additional?: number) => Promise<boolean>;
  chooseSpace: (id: string) => void;
  closeSpaceCreation: () => void;
};

export default function SpaceCreationModal({
  spaceCreationIntent,
  data,
  update,
  setToast,
  setSpaceCreationIntent,
  setImportTargetSpaceId,
  setModal,
  ensureCanActivateSpace,
  chooseSpace,
  closeSpaceCreation,
}: SpaceCreationModalProps) {
  return (
    <Modal
      title={spaceCreationIntent === "import" ? "创建知识库并导入资料" : "新建知识库"}
      onClose={closeSpaceCreation}
    >
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const name = String(f.get("name") || "").trim();
          if (!name) {
            setToast("请填写知识库名称。");
            const nameInput = e.currentTarget.elements.namedItem("name");
            if (nameInput instanceof HTMLInputElement) nameInput.focus();
            return;
          }
          const continueToImport = spaceCreationIntent === "import";
          if (
            ensureCanActivateSpace &&
            !(await ensureCanActivateSpace(
              continueToImport && isUntouchedStarterWorkspace(data) ? 0 : 1,
            ))
          )
            return;
          const id = crypto.randomUUID();
          const created = {
            id,
            name,
            goal: String(f.get("goal") || "").trim(),
            color: "#4B3FE3",
            archived: false,
            createdAt: new Date().toISOString(),
          };
          const updated = update((d) => ({
            ...d,
            spaces:
              continueToImport && isUntouchedStarterWorkspace(d)
                ? [created]
                : [...d.spaces, created],
          }));
          if (updated === false) {
            setToast("学习空间未创建，请稍后重试；当前内容仍然保留。");
            return;
          }
          setSpaceCreationIntent("browse");
          chooseSpace(id);
          if (continueToImport) {
            setImportTargetSpaceId(id);
            setModal("import");
          } else setModal(null);
        }}
      >
        <label>
          知识库名称
          <input
            className="field"
            name="name"
            maxLength={60}
            required
            placeholder="例如：机器学习入门"
            autoFocus
            onInvalid={(e) => {
              e.preventDefault();
              setToast("请填写知识库名称。");
              e.currentTarget.focus();
            }}
          />
        </label>
        <label>
          学习目标 <small>可选</small>
          <textarea
            className="field"
            name="goal"
            rows={3}
            maxLength={300}
            placeholder="你希望在这个主题中弄懂什么？"
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={closeSpaceCreation}>
            取消
          </button>
          <button className="btn btn-primary">
            {spaceCreationIntent === "import" ? "创建并导入" : "创建知识库"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
