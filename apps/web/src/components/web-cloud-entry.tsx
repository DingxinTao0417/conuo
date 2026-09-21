"use client";

import Image from "next/image";
import { Cloud, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isCloudConfigured, subscribeSession, type CloudUser } from "@/lib/cloud";
import AccountPanel, { type AccountEntryMode } from "./account-panel";
import Workspace from "./workspace";
import "./web-cloud-entry.css";

type EntryState =
  { kind: "loading" | "login" | "unavailable" } | { kind: "ready"; user: CloudUser };

const ignorePanelAction = () => {};

/** Web only opens an account workspace after authoritative Supabase verification. */
export default function WebCloudEntry() {
  const [entry, setEntry] = useState<EntryState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [accountMode, setAccountMode] = useState<AccountEntryMode>("login");
  const verifiedUser = useRef<CloudUser | null>(null);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    const unavailable = () => {
      if (!active) return;
      verifiedUser.current = null;
      setEntry({ kind: "unavailable" });
    };
    try {
      if (!isCloudConfigured()) queueMicrotask(unavailable);
      else
        unsubscribe = subscribeSession(
          (user) => {
            if (!active) return;
            verifiedUser.current = user;
            setEntry(user ? { kind: "ready", user } : { kind: "login" });
          },
          (hintedId) => {
            if (!active || !verifiedUser.current || verifiedUser.current.id === hintedId) return;
            // Cached events can revoke A immediately, but cannot authorize B.
            verifiedUser.current = null;
            setEntry({ kind: "loading" });
          },
        );
    } catch {
      queueMicrotask(unavailable);
    }
    return () => {
      active = false;
      verifiedUser.current = null;
      unsubscribe();
    };
  }, [attempt]);

  if (entry.kind === "ready") return <Workspace key={entry.user.id} storageMode="cloud" />;

  return (
    <main className="web-cloud-entry">
      <div className="web-cloud-entry-shell">
        <div className="web-cloud-brand" aria-label="Conuo">
          <Image src="/conuo-icon-192.png" alt="" width={40} height={40} priority />
          <span>Conuo</span>
        </div>
        <section className="web-cloud-entry-card" aria-labelledby="web-cloud-entry-title">
          <div className="web-cloud-entry-intro">
            <span className="web-cloud-entry-label">
              <Cloud size={15} />
              云端学习工作区
            </span>
            <h1 id="web-cloud-entry-title">
              {entry.kind === "loading"
                ? "正在连接你的工作区"
                : entry.kind === "unavailable"
                  ? "云端服务暂不可用"
                  : accountMode === "signup"
                    ? "创建你的学习空间"
                    : accountMode === "reset"
                      ? "找回密码"
                      : "登录，继续学习"}
            </h1>
            <p>
              {entry.kind === "login" && accountMode === "reset"
                ? "输入注册时使用的邮箱，我们会发送重置密码的链接。"
                : "资料、笔记与学习记录统一保存至云端，登录后即可继续。"}
            </p>
          </div>
          {entry.kind === "loading" ? (
            <p className="web-cloud-entry-status" role="status">
              <LoaderCircle size={19} className="web-cloud-entry-spinner" />
              正在确认登录状态…
            </p>
          ) : entry.kind === "unavailable" ? (
            <div className="web-cloud-entry-unavailable">
              <p role="alert">请检查网络或联系管理员确认云端配置，然后重试。</p>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  setEntry({ kind: "loading" });
                  setAttempt((value) => value + 1);
                }}
              >
                重新连接
              </button>
            </div>
          ) : (
            <div className="web-cloud-login">
              <AccountPanel
                appearance="entry"
                onModeChange={setAccountMode}
                onSessionChange={ignorePanelAction}
                onClose={ignorePanelAction}
              />
            </div>
          )}
        </section>
        <p className="web-cloud-entry-footer">陪你把知识学会。</p>
      </div>
    </main>
  );
}
