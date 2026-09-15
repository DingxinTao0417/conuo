"use client";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { EditorState } from "@tiptap/pm/state";
import {
  Bold,
  Italic,
  Heading2,
  List,
  ListOrdered,
  Code2,
  Undo2,
  Redo2,
  Table2,
  Link2,
  MoreHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export default function NoteEditor({
  content,
  onChange,
  searchText,
}: {
  content: string;
  onChange: (html: string) => void;
  searchText?: string;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState("");
  const moreFormats = useRef<HTMLDetailsElement>(null);
  const lastEditorContent = useRef(content);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        },
      }),
      TableKit,
    ],
    content,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      lastEditorContent.current = html;
      onChange(html);
    },
    editorProps: { attributes: { class: "note-content", "aria-label": "笔记正文" } },
  });
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const current = editor.getHTML();
    if (current === content) {
      lastEditorContent.current = content;
      return;
    }
    // A parent render that echoes this editor's latest update must not reset a
    // newer local selection. Different content is an external replacement,
    // such as a chosen cloud copy or a manual conflict merge.
    if (lastEditorContent.current === content) return;
    editor.commands.setContent(content, { emitUpdate: false });
    // setContent still records a ProseMirror history event. Recreate the state
    // with the same document and plugins so Undo cannot revive a discarded
    // conflict copy and feed it back through auto-save.
    editor.view.updateState(
      EditorState.create({
        doc: editor.state.doc,
        selection: editor.state.selection,
        plugins: editor.state.plugins,
      }),
    );
    lastEditorContent.current = content;
  }, [content, editor]);
  const locateSearch = useCallback(() => {
    if (!editor || !searchText) return false;
    const normalize = (text: string) => text.replace(/\s+/g, "").trim();
    const matches: Array<{ from: number; to: number }> = [];
    editor.state.doc.forEach((node, offset) => {
      if (normalize(node.textContent) === normalize(searchText) && node.nodeSize > 2)
        matches.push({ from: offset + 1, to: offset + node.nodeSize - 1 });
    });
    if (matches.length !== 1) return false;
    return editor.chain().setTextSelection(matches[0]).focus().scrollIntoView().run();
  }, [editor, searchText]);
  useEffect(() => {
    if (!editor || !searchText) return;
    const show = () => {
      locateSearch();
    };
    editor.on("create", show);
    editor.on("mount", show);
    show();
    return () => {
      editor.off("create", show);
      editor.off("mount", show);
    };
  }, [editor, searchText, locateSearch]);
  if (!editor) return <div className="note-content muted">正在打开编辑器…</div>;
  const actions = [
    {
      id: "bold",
      label: "粗体",
      icon: <Bold size={16} />,
      active: editor.isActive("bold"),
      mobile: "primary",
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      id: "italic",
      label: "斜体",
      icon: <Italic size={16} />,
      active: editor.isActive("italic"),
      mobile: "primary",
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      id: "heading",
      label: "二级标题",
      icon: <Heading2 size={16} />,
      active: editor.isActive("heading", { level: 2 }),
      mobile: "more",
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      id: "bullet-list",
      label: "无序列表",
      icon: <List size={16} />,
      active: editor.isActive("bulletList"),
      mobile: "primary",
      separator: true,
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      id: "ordered-list",
      label: "有序列表",
      icon: <ListOrdered size={16} />,
      active: editor.isActive("orderedList"),
      mobile: "more",
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      id: "code-block",
      label: "代码块",
      icon: <Code2 size={16} />,
      active: editor.isActive("codeBlock"),
      mobile: "more",
      run: () => editor.chain().focus().toggleCodeBlock().run(),
    },
    {
      id: "table",
      label: "插入表格",
      icon: <Table2 size={16} />,
      active: undefined,
      mobile: "more",
      run: () =>
        editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      id: "link",
      label: "添加链接",
      icon: <Link2 size={16} />,
      active: editor.isActive("link"),
      mobile: "more",
      run: () => setLinkOpen((current) => !current),
    },
    {
      id: "undo",
      label: "撤销",
      icon: <Undo2 size={16} />,
      active: undefined,
      mobile: "primary",
      separator: true,
      run: () => editor.chain().focus().undo().run(),
    },
    {
      id: "redo",
      label: "重做",
      icon: <Redo2 size={16} />,
      active: undefined,
      mobile: "more",
      run: () => editor.chain().focus().redo().run(),
    },
  ] as const;
  return (
    <div className="editor-wrap">
      {searchText && (
        <details className="note-search-location">
          <summary>搜索命中的原文片段</summary>
          <p>{searchText}</p>
          <button className="btn" type="button" onClick={() => locateSearch()}>
            定位正文
          </button>
        </details>
      )}
      <div className="editor-toolbar editor-toolbar-desktop" role="toolbar" aria-label="文字格式">
        {actions.map((action) => (
          <span className="editor-toolbar-item" key={action.id}>
            {"separator" in action && action.separator && (
              <span className="toolbar-separator" aria-hidden="true" />
            )}
            <button
              type="button"
              title={action.label}
              aria-label={action.label}
              aria-pressed={action.active}
              className="icon-btn"
              onClick={action.run}
            >
              {action.icon}
            </button>
          </span>
        ))}
      </div>
      <div className="editor-toolbar editor-toolbar-mobile" role="toolbar" aria-label="文字格式">
        {actions
          .filter((action) => action.mobile === "primary")
          .map((action) => (
            <button
              type="button"
              title={action.label}
              aria-label={action.label}
              aria-pressed={action.active}
              className="icon-btn"
              key={action.id}
              onClick={action.run}
            >
              {action.icon}
            </button>
          ))}
        <details className="editor-toolbar-more" ref={moreFormats}>
          <summary className="icon-btn" aria-label="更多格式" title="更多格式">
            <MoreHorizontal size={18} />
          </summary>
          <div className="editor-toolbar-more-menu" role="group" aria-label="更多格式">
            {actions
              .filter((action) => action.mobile === "more")
              .map((action) => (
                <button
                  type="button"
                  aria-pressed={action.active}
                  className="editor-toolbar-menu-action"
                  key={action.id}
                  onClick={() => {
                    action.run();
                    moreFormats.current?.removeAttribute("open");
                  }}
                >
                  {action.icon}
                  <span>{action.label}</span>
                </button>
              ))}
          </div>
        </details>
      </div>
      {linkOpen && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^https?:\/\//i.test(link)) {
              editor.chain().focus().extendMarkRange("link").setLink({ href: link }).run();
              setLinkOpen(false);
              setLink("");
            }
          }}
        >
          <input
            className="field"
            type="url"
            required
            pattern="https?://.*"
            placeholder="https://"
            aria-label="链接网址"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <button className="btn" type="submit">
            插入
          </button>
        </form>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
