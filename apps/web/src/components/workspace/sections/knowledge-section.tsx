"use client";
import { ArrowDownToLine, Plus, Sparkles } from "lucide-react";
import type { WorkspaceExportScope } from "@/lib/export-scope";
import type { Space, WorkspaceData } from "@/lib/types";
import type { KnowledgeLibraryFilter } from "@/lib/workspace-section-route";
import KnowledgeLibrary from "../../knowledge-library";

export type KnowledgeSectionProps = {
  data: WorkspaceData;
  spaceId: string;
  activeSpace: Space | undefined;
  knowledgePageCount: number;
  search: string;
  knowledgeFilter: KnowledgeLibraryFilter;
  busy: boolean;
  openOrganization: () => void;
  openExport: (scope: WorkspaceExportScope) => void;
  newNote: (kind: "knowledge") => void;
  openNote: (id: string) => void;
  replaceKnowledgeView: (next: { query?: string; filter?: KnowledgeLibraryFilter }) => void;
};

export default function KnowledgeSection({
  data,
  spaceId,
  activeSpace,
  knowledgePageCount,
  search,
  knowledgeFilter,
  busy,
  openOrganization,
  openExport,
  newNote,
  openNote,
  replaceKnowledgeView,
}: KnowledgeSectionProps) {
  return (
    <>
      <div className="document-library-heading">
        <div>
          <h2>
            {spaceId === "all" ? "全部" : "库内"}
            知识页
            <span className="count-badge">{knowledgePageCount}</span>
          </h2>
          <p>从原文依据出发，按知识库整理、审核并保存你的知识页。</p>
        </div>
        <div className="knowledge-actions">
          <button className="btn" onClick={() => openOrganization()}>
            <Sparkles size={16} />
            从资料生成
          </button>
          {activeSpace && (
            <button
              className="btn export-library-action"
              disabled={busy}
              onClick={() => openExport({ kind: "space", spaceId: activeSpace.id })}
            >
              <ArrowDownToLine size={15} aria-hidden="true" />
              导出此知识库
            </button>
          )}
          <button className="btn btn-primary" onClick={() => newNote("knowledge")}>
            <Plus size={16} />
            新建知识页
          </button>
        </div>
      </div>
      <KnowledgeLibrary
        data={data}
        spaceId={spaceId}
        query={search}
        filter={knowledgeFilter}
        onQueryChange={(query) => replaceKnowledgeView({ query })}
        onFilterChange={(nextFilter) => replaceKnowledgeView({ filter: nextFilter })}
        onOpen={openNote}
      />
    </>
  );
}
