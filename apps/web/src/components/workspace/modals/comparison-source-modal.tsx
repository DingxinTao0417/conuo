"use client";
import type { Source, Space } from "@/lib/types";
import Modal from "../../modal";
import { SourceIcon, sourceStatusLabel } from "../shared";

export type ComparisonSourceModalProps = {
  readingSource: Source | null | undefined;
  comparisonPickerSpace: Space | undefined;
  comparisonCandidates: Source[];
  comparisonTargetId: string;
  setComparisonTargetId: (id: string) => void;
  setModal: (modal: null) => void;
  startComparison: () => void;
};

export default function ComparisonSourceModal({
  readingSource,
  comparisonPickerSpace,
  comparisonCandidates,
  comparisonTargetId,
  setComparisonTargetId,
  setModal,
  startComparison,
}: ComparisonSourceModalProps) {
  return (
    <Modal
      title="选择要对照的资料"
      onClose={() => {
        setModal(null);
        setComparisonTargetId("");
      }}
    >
      <div className="modal-body comparison-source-picker">
        <p className="bulk-space-intro">
          将与“{readingSource?.title || "当前资料"}”在“
          {comparisonPickerSpace?.name || "当前知识库"}
          ”中并排打开。进入后会固定两份资料的当前阅读版本；
          若资料或版本已变化，系统不会替换为其他内容。
        </p>
        {comparisonCandidates.length ? (
          <fieldset className="comparison-source-fieldset">
            <legend>选择另一份资料</legend>
            <div className="comparison-source-list" role="radiogroup" aria-label="对照资料">
              {comparisonCandidates.map((source) => (
                <label
                  className={`comparison-source-option ${
                    comparisonTargetId === source.id ? "selected" : ""
                  }`}
                  key={source.id}
                >
                  <input
                    type="radio"
                    name="comparison-source"
                    checked={comparisonTargetId === source.id}
                    onChange={() => setComparisonTargetId(source.id)}
                  />
                  <SourceIcon source={source} />
                  <span>
                    <b>{source.title}</b>
                    <small>
                      {sourceStatusLabel(source)} · {source.filename}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="muted">当前知识库没有可选的另一份资料。</p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setModal(null);
              setComparisonTargetId("");
            }}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!comparisonTargetId || !comparisonCandidates.length}
            onClick={startComparison}
          >
            开始对照阅读
          </button>
        </div>
      </div>
    </Modal>
  );
}
