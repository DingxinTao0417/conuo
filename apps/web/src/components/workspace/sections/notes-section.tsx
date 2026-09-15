"use client";
import type { RefObject } from "react";
import { Plus, Search, StickyNote } from "lucide-react";
import type { Note } from "@/lib/types";
import { Empty, date, plain } from "../shared";

export type NotesSectionProps = {
  spaceId: string;
  notes: Note[];
  search: string;
  searchRef: RefObject<HTMLInputElement | null>;
  setSearch: (value: string) => void;
  newNote: (kind: "note") => void;
  openNote: (id: string) => void;
};

export default function NotesSection({
  spaceId,
  notes,
  search,
  searchRef,
  setSearch,
  newNote,
  openNote,
}: NotesSectionProps) {
  return (
    <>
      <div className="document-library-heading">
        <div>
          <h2>
            {spaceId === "all" ? "全部" : "库内"}笔记
            <span className="count-badge">{notes.length}</span>
          </h2>
          <p>摘录是起点，自己的思考更值得保存。</p>
        </div>
        <div className="knowledge-actions">
          <button className="btn btn-primary" onClick={() => newNote("note")}>
            <Plus size={16} />
            新建笔记
          </button>
        </div>
      </div>
      <div className="search-field note-search">
        <Search size={16} />
        <input
          ref={searchRef}
          placeholder="搜索标题或正文…"
          aria-label="搜索笔记"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {notes.length ? (
        <div className="note-grid">
          {notes.map((n) => (
            <button className="note-card" key={n.id} onClick={() => openNote(n.id)}>
              <div>
                <StickyNote size={18} />
                {n.status === "draft" && <span className="badge badge-warning">待审核</span>}
              </div>
              <h3>{n.title}</h3>
              <p>{plain(n.content).slice(0, 160) || "还没有正文，开始记录你的思考。"}</p>
              <footer>
                {date(n.updatedAt)} 更新{" "}
                <span>{n.citations.length ? `${n.citations.length} 处依据` : "自由笔记"}</span>
              </footer>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          icon={<StickyNote size={32} />}
          title={search ? "没有找到匹配的笔记" : "留下此刻的理解"}
          text="可以从空白笔记开始，也可以在阅读时保存选段。"
        />
      )}
    </>
  );
}
