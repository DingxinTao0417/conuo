"use client";
import { FileText } from "lucide-react";
import type { Source, Space } from "@/lib/types";
import { sourceCoverageLabel } from "@/lib/source-coverage";

export const statusLabel = {
  saved: "已保存",
  parsing: "解析中",
  ready: "可检索",
  partial: "部分可检索",
  failed: "解析失败",
  "link-only": "仅链接",
};
export const sourceStatusLabel = (source: Source) =>
  sourceCoverageLabel(source) || statusLabel[source.status];

export const plain = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
export const normalizedTag = (value: string) =>
  value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
export const date = (value: string) =>
  new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
export const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
export const inboxSpace: Space = {
  id: "inbox",
  name: "收件箱",
  goal: "",
  color: "#4B3FE3",
  archived: false,
  createdAt: "",
};

export function SourceIcon({ source }: { source: Source }) {
  return (
    <span className={`file-icon file-${source.kind}`}>
      <FileText size={21} />
      <small>{source.kind === "markdown" ? "MD" : source.kind.toUpperCase()}</small>
    </span>
  );
}

export function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  );
}
