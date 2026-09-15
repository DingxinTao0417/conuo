"use client";
import type { Conversation } from "@/lib/types";
import { isCrossLibraryConversation } from "@/lib/cross-library-ask";
import Modal from "../../modal";

export default function ConversationHistoryModal({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const crossLibrary = isCrossLibraryConversation(conversation);
  return (
    <Modal title={conversation.title} onClose={onClose}>
      <div className="modal-body conversation-history-modal">
        <p className="muted">
          {crossLibrary
            ? `这条跨库问答的 ${conversation.sourceIds.length} 份固定资料或版本已不能安全恢复。记录保留为只读内容，不会参与新的 AI 问答或检索。`
            : "原资料当前不可用。这份问答记录保留为只读内容，不会参与新的 AI 问答或检索。"}
        </p>
        <div className="conversation-transcript" aria-label="已保存的问答记录">
          {conversation.messages.length ? (
            conversation.messages.map((message) => (
              <article
                className={`conversation-transcript-message ${message.role}`}
                key={message.id}
              >
                <b>{message.role === "user" ? "你的问题" : "已保存的回答"}</b>
                <p>{message.content || (message.error ? "这次回答没有完成。" : "暂无正文")}</p>
                {message.error && <small>失败原因：{message.error}</small>}
                {message.citations.length > 0 && (
                  <details>
                    <summary>当时引用的 {message.citations.length} 处原文</summary>
                    <ul>
                      {message.citations.map((citation, index) => (
                        <li
                          key={`${citation.sourceId}:${citation.versionId}:${citation.chunkId}:${index}`}
                        >
                          {citation.title}：{citation.quote}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {!!message.noteEvidence?.length && (
                  <details>
                    <summary>当时参考的 {message.noteEvidence.length} 段我的笔记</summary>
                    <ul>
                      {message.noteEvidence.map((evidence, index) => (
                        <li key={`${evidence.noteId}:${evidence.blockId}:${index}`}>
                          {evidence.title}：{evidence.quote}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            ))
          ) : (
            <p className="muted">这条记录没有保留消息正文。</p>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </Modal>
  );
}
