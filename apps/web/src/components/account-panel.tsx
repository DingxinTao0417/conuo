"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Cloud, HardDrive, LogOut, X } from "lucide-react";
import {
  isCloudConfigured,
  previewAccountDeletion,
  requestAccountDeletion,
  subscribeSession,
  type AccountDeletionPreview,
  type CloudUser,
} from "@/lib/cloud";
import { createClient } from "@/lib/supabase/client";
import { isAccountDeletionPendingError } from "@/lib/account-deletion";
import { clearAccountLocalCache } from "@/lib/local-store";
import { webSessionStore } from "@/lib/web-session-store";
import { webReviewDraftStore } from "@/lib/web-review-draft-store";

export type AccountSignOutState = {
  /**
   * `ready` means the workspace has no pending content that needs an exit
   * decision. It also covers a confirmed cloud-readonly view: the browser may
   * be unable to read its cache, but this session has no new local draft.
   */
  kind: "ready" | "syncing" | "unsynced" | "conflict" | "local-error";
  /** User-facing explanation supplied by the workspace coordinator when available. */
  message?: string;
  /** Whether the coordinator can finish/retry synchronization before signing out. */
  canSync: boolean;
  /** Whether the coordinator can first persist a protected account-local draft. */
  canKeepLocalDraft: boolean;
};

/**
 * AccountPanel owns the exit choice; the workspace owns durability and account-scoped data.
 * Each supplied action must resolve only after its named safety condition and sign-out complete.
 */
export type AccountSignOutControl = {
  state: AccountSignOutState;
  signOut: () => Promise<void>;
  syncAndSignOut: () => Promise<void>;
  keepLocalDraftAndSignOut: () => Promise<void>;
};

export type AccountEntryMode = "login" | "signup" | "reset";
type Props = {
  appearance?: "panel" | "entry";
  /** Mode shown first, e.g. "signup" when opened from a sign-up call to action. */
  initialMode?: AccountEntryMode;
  onModeChange?: (mode: AccountEntryMode) => void;
  storageMode?: "hybrid" | "cloud";
  onSessionChange: (user: CloudUser | null) => void;
  onClose: () => void;
  /** Clears the just-deleted account's browser cache before local sign-out. */
  onAccountDeletion?: (accountId: string) => Promise<void> | void;
  /** Optional workspace-owned guard for explicit account exit. */
  signOutControl?: AccountSignOutControl;
};
const defaultSignOutState: AccountSignOutState = {
  kind: "ready",
  canSync: false,
  canKeepLocalDraft: false,
};

function defaultSignOutMessage(state: AccountSignOutState) {
  if (state.message) return state.message;
  if (state.kind === "syncing")
    return "资料仍在同步。请等待同步完成，或先在这台设备保留一份受保护的本机草稿。";
  if (state.kind === "unsynced")
    return "部分修改尚未确认保存到云端。退出前可以继续同步，或先在这台设备保留一份受保护的本机草稿。";
  if (state.kind === "conflict")
    return "本机副本与云端副本存在冲突。请先解决冲突，或保留这台设备上的受保护草稿后再退出。";
  return "这台设备尚未安全保存当前草稿。请先解决本机保存问题后再退出。";
}

export default function AccountPanel({
  appearance = "panel",
  initialMode = "login",
  onModeChange,
  storageMode = "hybrid",
  onSessionChange,
  onClose,
  onAccountDeletion,
  signOutControl,
}: Props) {
  const [user, setUser] = useState<CloudUser | null>(null);
  const [mode, setMode] = useState<AccountEntryMode>(initialMode);
  useEffect(() => onModeChange?.(mode), [mode, onModeChange]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deletionPreview, setDeletionPreview] = useState<AccountDeletionPreview | null>(null);
  const [deletionEmail, setDeletionEmail] = useState("");
  const [deletionPassword, setDeletionPassword] = useState("");
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionError, setDeletionError] = useState("");
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signOutAction, setSignOutAction] = useState<"direct" | "sync" | "local" | null>(null);
  const configured = isCloudConfigured();
  const currentSignOutState = signOutControl?.state ?? defaultSignOutState;
  const sessionListener = useRef(onSessionChange);
  const currentUser = useRef<CloudUser | null>(null);
  const deletionRequest = useRef<AbortController | null>(null);
  const deletionSubmission = useRef<object | null>(null);
  // React state is committed after the event handler returns. Keep a synchronous
  // lock as well, so two clicks in the same render cannot start two exit flows.
  const signOutInFlight = useRef(false);
  useEffect(() => {
    sessionListener.current = onSessionChange;
  }, [onSessionChange]);
  useEffect(() => {
    const unsubscribe = subscribeSession(
      (next) => {
        if (currentUser.current?.id !== next?.id) {
          deletionRequest.current?.abort();
          deletionRequest.current = null;
          deletionSubmission.current = null;
          setDeletionOpen(false);
          setDeletionPreview(null);
          setDeletionEmail("");
          setDeletionPassword("");
          setDeletionConfirmation("");
          setDeletionError("");
          setDeletionBusy(false);
          setSignOutOpen(false);
          setSignOutAction(null);
        }
        currentUser.current = next;
        setUser(next);
        sessionListener.current(next);
      },
      (hintedAccountId) => {
        if (currentUser.current?.id === hintedAccountId) return;
        // Cached Auth events can invalidate A immediately, but only getUser may
        // authorize/display B. Do not wait for its deferred verification to stop
        // an accepted A request from exiting the browser's new Auth session.
        currentUser.current = null;
        deletionRequest.current?.abort();
        deletionRequest.current = null;
        deletionSubmission.current = null;
        setUser(null);
        setDeletionOpen(false);
        setDeletionPreview(null);
        setDeletionEmail("");
        setDeletionPassword("");
        setDeletionConfirmation("");
        setDeletionBusy(false);
      },
    );
    return () => {
      // A committed deletion still needs actor-scoped cleanup after unmount,
      // but this instance can no longer exit or publish into the current login.
      currentUser.current = null;
      deletionRequest.current?.abort();
      unsubscribe();
    };
  }, []);

  async function cleanDeletedAccount(accountId: string): Promise<boolean> {
    try {
      if (onAccountDeletion) await onAccountDeletion(accountId);
      else if (storageMode === "cloud") {
        await webSessionStore.markAccountLocalDeletion(accountId);
        await webSessionStore.clearAccountLocalCache(accountId);
        await webReviewDraftStore.clear(accountId, { blockReload: true });
      } else await clearAccountLocalCache(accountId);
      return true;
    } catch {
      return false;
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const client = createClient();
      const callback = `${window.location.origin}/auth/callback`;
      if (mode === "reset") {
        const result = await client.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${callback}?next=/auth/reset-password`,
        });
        if (result.error) throw result.error;
        setNotice("如果此邮箱可以接收重置邮件，你将收到修改密码的链接。");
      } else if (mode === "signup") {
        const result = await client.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: callback },
        });
        if (result.error) throw result.error;
        setNotice(
          result.data.session ? "账号已创建并登录。" : "请查看邮箱中的确认邮件，完成验证后再登录。",
        );
        setPassword("");
      } else {
        const result = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (result.error) throw result.error;
        setPassword("");
        setNotice("已登录。资料的保存状态会在工作区中显示。");
      }
    } catch (reason) {
      const code =
        reason && typeof reason === "object" && "code" in reason ? String(reason.code) : "";
      const messages: Record<string, string> = {
        invalid_credentials: "邮箱或密码不正确，请检查后重试。",
        email_not_confirmed: "请先通过邮件确认邮箱。",
        user_already_exists: "此邮箱已注册，请直接登录。",
        weak_password: "密码强度不足，请使用更长、更复杂的密码。",
        over_email_send_rate_limit: "邮件发送过于频繁，请稍后再试。",
        over_request_rate_limit: "操作过于频繁，请稍后重试。",
        signup_disabled: "当前暂未开放注册。",
      };
      setError(messages[code] ?? "操作未完成，请检查网络、邮箱及云端账号配置后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function localSignOut() {
    const { error: signOutError } = await createClient().auth.signOut({ scope: "local" });
    if (signOutError) throw signOutError;
  }

  async function finishSignOut(action: "direct" | "sync" | "local") {
    if (signOutInFlight.current) return;
    signOutInFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setSignOutAction(action);
    try {
      if (action === "sync") await signOutControl!.syncAndSignOut();
      else if (action === "local") await signOutControl!.keepLocalDraftAndSignOut();
      else if (signOutControl) await signOutControl.signOut();
      else await localSignOut();
      setSignOutOpen(false);
      setNotice("已退出此浏览器的账号。");
    } catch {
      setError(
        action === "sync"
          ? "同步未完成，当前账号仍保持登录。请检查同步状态后重试。"
          : action === "local"
            ? "本机草稿尚未安全保存，当前账号仍保持登录。"
            : "退出未完成，请稍后重试。",
      );
    } finally {
      signOutInFlight.current = false;
      setSignOutAction(null);
      setBusy(false);
    }
  }

  function requestSignOut() {
    setError("");
    setNotice("");
    if (currentSignOutState.kind === "ready") {
      void finishSignOut("direct");
      return;
    }
    setSignOutOpen(true);
  }

  function deletionMessage(reason: unknown) {
    const code =
      reason && typeof reason === "object" && "code" in reason ? String(reason.code) : "";
    const messages: Record<string, string> = {
      ACCOUNT_DELETION_CONFIRMATION_FAILED: "当前邮箱或密码不正确，请检查后重试。",
      ACCOUNT_DELETION_SESSION_CHANGED: "当前账号已改变，请刷新后重新确认注销。",
      ACCOUNT_DELETION_STATE_CHANGED: "账号状态已改变，请刷新后重新查看影响范围。",
      ACCOUNT_DELETION_PENDING: "账号注销正在处理中，资料访问已停止。",
      INVALID_ACCOUNT_DELETION_CONFIRMATION: "请填写当前邮箱、密码，并输入 DELETE 后再确认。",
    };
    return messages[code] ?? "账号注销暂未完成，请稍后重试。";
  }

  async function openDeletion() {
    if (!user || deletionBusy) return;
    const accountId = user.id;
    deletionRequest.current?.abort();
    const controller = new AbortController();
    deletionRequest.current = controller;
    setDeletionOpen(true);
    setDeletionPreview(null);
    setDeletionError("");
    setDeletionBusy(true);
    try {
      const preview = await previewAccountDeletion(accountId, controller.signal);
      // This response is bound to the captured account by the cloud adapter.
      // Persist its confirmed fence even if the current panel moved to B.
      const cleaned =
        !preview.allowed && preview.state !== null ? await cleanDeletedAccount(accountId) : true;
      if (controller.signal.aborted || currentUser.current?.id !== accountId) return;
      setDeletionPreview(preview);
      if (!cleaned) setDeletionError("本机缓存未能完全清理，请在浏览器设置中清除本站数据。");
    } catch (reason) {
      const cleaned = isAccountDeletionPendingError(reason)
        ? await cleanDeletedAccount(accountId)
        : true;
      if (!controller.signal.aborted && currentUser.current?.id === accountId)
        setDeletionError(
          deletionMessage(reason) +
            (cleaned ? "" : " 本机缓存未能完全清理，请在浏览器设置中清除本站数据。"),
        );
    } finally {
      if (deletionRequest.current === controller) deletionRequest.current = null;
      if (!controller.signal.aborted && currentUser.current?.id === accountId)
        setDeletionBusy(false);
    }
  }

  function closeDeletion() {
    deletionRequest.current?.abort();
    deletionRequest.current = null;
    setDeletionOpen(false);
    setDeletionPreview(null);
    setDeletionPassword("");
    setDeletionConfirmation("");
    setDeletionError("");
    setDeletionBusy(false);
  }

  async function submitDeletion(event: FormEvent) {
    event.preventDefault();
    if (
      !user ||
      !deletionPreview ||
      !deletionPreview.allowed ||
      deletionBusy ||
      deletionSubmission.current
    )
      return;
    const accountId = user.id;
    const operation = {};
    deletionSubmission.current = operation;
    setDeletionBusy(true);
    setDeletionError("");
    try {
      const result = await requestAccountDeletion(
        {
          email: deletionEmail,
          password: deletionPassword,
          confirmation: deletionConfirmation as "DELETE",
        },
        accountId,
      );
      // Server acceptance is durable for A, independently of the current login.
      const localCacheNeedsManualCleanup = !(await cleanDeletedAccount(accountId));
      if (currentUser.current?.id !== accountId) return;
      setDeletionPassword("");
      const { error: signOutError } = await createClient().auth.signOut({ scope: "local" });
      if (signOutError) throw new Error("LOCAL_SIGN_OUT_FAILED");
      if (currentUser.current?.id !== accountId) return;
      currentUser.current = null;
      setUser(null);
      sessionListener.current(null);
      setDeletionOpen(false);
      setDeletionPreview(null);
      setNotice(
        (result.readyForAuthDeletion
          ? "账号注销请求已完成资料清理，正在完成账号移除。"
          : "账号注销请求已提交。云端资料已停止访问，原件清理完成后将删除账号。") +
          (localCacheNeedsManualCleanup
            ? " 本机缓存未能完全清理，请在浏览器设置中清除本站数据。"
            : ""),
      );
    } catch (reason) {
      if (isAccountDeletionPendingError(reason)) await cleanDeletedAccount(accountId);
      if (currentUser.current?.id === accountId) {
        const isLocalSignOut =
          reason instanceof Error && reason.message === "LOCAL_SIGN_OUT_FAILED";
        setDeletionError(
          isLocalSignOut
            ? "注销请求已提交，但此浏览器未能退出。请关闭当前页面后再重新打开。"
            : deletionMessage(reason),
        );
      }
    } finally {
      if (deletionSubmission.current === operation) deletionSubmission.current = null;
      if (currentUser.current?.id === accountId) setDeletionBusy(false);
    }
  }

  return (
    <section
      className="account-panel"
      aria-labelledby={appearance === "entry" ? "web-cloud-entry-title" : "account-title"}
      style={{
        width: "100%",
        maxWidth: 420,
        margin: "0 auto",
        padding: 8,
        background: "white",
        borderRadius: 12,
      }}
    >
      {appearance !== "entry" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {configured ? (
              <Cloud size={22} color="#4B3FE3" />
            ) : (
              <HardDrive size={22} color="#4B3FE3" />
            )}
            <h2 id="account-title" style={{ margin: 0, fontSize: 20 }}>
              {configured ? "账号与云端资料" : "本机工作区"}
            </h2>
          </div>
          <button
            type="button"
            className="btn icon-btn"
            aria-label="关闭账号设置"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {!configured ? (
        <div style={{ lineHeight: 1.8 }}>
          <p>当前使用本机工作区。资料仅保存在这个浏览器中。</p>
          <p style={{ color: "#737373", fontSize: 13 }}>
            云端同步暂不可用。请定期导出备份，以免清除网站数据后丢失本机副本。
          </p>
          <button className="btn" onClick={onClose}>
            继续使用本机工作区
          </button>
        </div>
      ) : user ? (
        <div style={{ display: "grid", gap: 18 }}>
          <div>
            <p style={{ color: "#737373", fontSize: 13, marginBottom: 6 }}>当前账号</p>
            <strong style={{ wordBreak: "break-all" }}>{user.email}</strong>
          </div>
          <p style={{ fontSize: 13, color: "#737373", lineHeight: 1.7 }}>
            {storageMode === "cloud"
              ? "资料、笔记与学习记录统一保存到云端。尚未确认的修改仅暂存在当前页面，请等保存完成后退出。"
              : "文件上传完成并确认保存后，工作区才会显示“已保存至云端”。本机草稿和云端版本发生冲突时，请先保留副本。"}
          </p>
          <a href="/auth/reset-password" style={{ color: "#4B3FE3", fontSize: 14 }}>
            修改密码
          </a>
          <button
            className="btn"
            disabled={busy || deletionBusy}
            onClick={requestSignOut}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <LogOut size={16} />
            {signOutAction === "sync"
              ? "正在同步…"
              : signOutAction === "local"
                ? "正在保护草稿…"
                : busy
                  ? "正在退出…"
                  : "退出当前账号"}
          </button>
          {signOutOpen && (
            <section
              aria-label="退出保护"
              style={{
                display: "grid",
                gap: 10,
                padding: 12,
                borderRadius: 8,
                background: "#FFF8ED",
              }}
            >
              <div>
                <strong style={{ color: "#8A5700", fontSize: 14 }}>还有尚未确认的内容</strong>
                <p style={{ margin: "6px 0 0", color: "#66552F", fontSize: 13, lineHeight: 1.7 }}>
                  {defaultSignOutMessage(currentSignOutState)}
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {currentSignOutState.canSync && signOutControl && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || deletionBusy}
                    onClick={() => void finishSignOut("sync")}
                  >
                    等待同步后退出
                  </button>
                )}
                {storageMode !== "cloud" &&
                  currentSignOutState.canKeepLocalDraft &&
                  signOutControl && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || deletionBusy}
                      onClick={() => void finishSignOut("local")}
                    >
                      保留本机草稿后退出
                    </button>
                  )}
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy || deletionBusy}
                  onClick={() => setSignOutOpen(false)}
                >
                  取消
                </button>
              </div>
              {!currentSignOutState.canSync && !currentSignOutState.canKeepLocalDraft && (
                <p style={{ margin: 0, color: "#8A5700", fontSize: 12, lineHeight: 1.6 }}>
                  当前不能安全退出。请先解决上方问题，或导出资料后再离开。
                </p>
              )}
            </section>
          )}
          <section
            aria-label="注销账号"
            style={{ borderTop: "1px solid #E5E5E5", paddingTop: 18, display: "grid", gap: 12 }}
          >
            <div>
              <strong style={{ color: "#A32D2D", fontSize: 14 }}>注销账号</strong>
              <p style={{ margin: "6px 0 0", color: "#737373", fontSize: 13, lineHeight: 1.7 }}>
                注销后会停止云端访问，并删除云端资料、版本、笔记、问答、批注和原件。此操作不可撤销。
              </p>
            </div>
            {!deletionOpen ? (
              <button
                type="button"
                className="btn ghost"
                disabled={busy || deletionBusy}
                onClick={openDeletion}
                style={{ justifySelf: "start", color: "#A32D2D" }}
              >
                注销账号
              </button>
            ) : deletionBusy && !deletionPreview ? (
              <p role="status" style={{ margin: 0, color: "#737373", fontSize: 13 }}>
                正在核对账号中的资料与原件…
              </p>
            ) : deletionPreview ? (
              deletionPreview.allowed ? (
                <form onSubmit={submitDeletion} style={{ display: "grid", gap: 12 }}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                      gap: 8,
                      padding: 12,
                      borderRadius: 8,
                      background: "#F7F7F8",
                      fontSize: 12,
                      color: "#555",
                    }}
                  >
                    <span>{deletionPreview.sources} 份资料</span>
                    <span>{deletionPreview.versions} 个版本</span>
                    <span>{deletionPreview.notes} 条笔记</span>
                    <span>{deletionPreview.conversations} 段问答</span>
                    <span>{deletionPreview.annotations} 条批注</span>
                    <span>{deletionPreview.totalStorageObjects} 个云端原件</span>
                  </div>
                  {deletionPreview.pendingSourcePurgeObjects > 0 && (
                    <p style={{ margin: 0, color: "#737373", fontSize: 12, lineHeight: 1.6 }}>
                      其中有 {deletionPreview.pendingSourcePurgeObjects}{" "}
                      个原件已在资料回收站清理队列中， 会一并完成处理。
                    </p>
                  )}
                  <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
                    输入当前邮箱以确认
                    <input
                      className="field"
                      type="email"
                      autoComplete="email"
                      required
                      maxLength={254}
                      value={deletionEmail}
                      onChange={(event) => setDeletionEmail(event.target.value)}
                      style={{ padding: "10px 12px", border: "1px solid #E5E5E5", borderRadius: 8 }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
                    输入当前密码
                    <input
                      className="field"
                      type="password"
                      autoComplete="current-password"
                      required
                      maxLength={128}
                      value={deletionPassword}
                      onChange={(event) => setDeletionPassword(event.target.value)}
                      style={{ padding: "10px 12px", border: "1px solid #E5E5E5", borderRadius: 8 }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
                    输入 DELETE 以确认
                    <input
                      className="field"
                      type="text"
                      autoComplete="off"
                      required
                      maxLength={6}
                      value={deletionConfirmation}
                      onChange={(event) => setDeletionConfirmation(event.target.value)}
                      style={{ padding: "10px 12px", border: "1px solid #E5E5E5", borderRadius: 8 }}
                    />
                  </label>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      className="btn"
                      type="submit"
                      disabled={
                        deletionBusy ||
                        deletionEmail.trim().toLowerCase() !== user.email.trim().toLowerCase() ||
                        !deletionPassword ||
                        deletionConfirmation !== "DELETE"
                      }
                      style={{ color: "white", background: "#B42318", border: 0 }}
                    >
                      {deletionBusy ? "正在提交…" : "确认注销账号"}
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={deletionBusy}
                      onClick={closeDeletion}
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  <p
                    role="status"
                    style={{ margin: 0, color: "#A35C00", fontSize: 13, lineHeight: 1.7 }}
                  >
                    账号注销正在处理中。云端资料与原件已经停止访问，清理完成后将删除账号。
                  </p>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={deletionBusy}
                    onClick={closeDeletion}
                  >
                    关闭状态
                  </button>
                </div>
              )
            ) : null}
            {deletionError && (
              <p
                role="alert"
                style={{ color: "#C1342C", fontSize: 13, lineHeight: 1.7, margin: 0 }}
              >
                {deletionError}
              </p>
            )}
          </section>
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
          {appearance !== "entry" && (
            <p style={{ margin: 0, color: "#737373", fontSize: 14 }}>
              {mode === "signup"
                ? "创建账号，保存你的学习资料。"
                : mode === "reset"
                  ? "通过邮箱找回账号。"
                  : "登录后继续你的云端学习工作区。"}
            </p>
          )}
          <label style={{ display: "grid", gap: 7, fontSize: 13 }}>
            邮箱
            <input
              className="field"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoFocus
              style={{ padding: "10px 12px", border: "1px solid #E5E5E5", borderRadius: 8 }}
            />
          </label>
          {mode !== "reset" && (
            <label style={{ display: "grid", gap: 7, fontSize: 13 }}>
              密码
              <input
                className="field"
                type="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                required
                minLength={mode === "signup" ? 10 : 1}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                style={{ padding: "10px 12px", border: "1px solid #E5E5E5", borderRadius: 8 }}
              />
              {mode === "signup" && (
                <span style={{ fontSize: 12, color: "#737373" }}>至少 10 个字符。</span>
              )}
            </label>
          )}
          <button
            className="btn primary"
            type="submit"
            disabled={busy}
            style={{
              padding: "11px 16px",
              background: "#4B3FE3",
              borderRadius: 8,
              color: "white",
              border: 0,
            }}
          >
            {busy
              ? "正在处理…"
              : mode === "signup"
                ? "注册"
                : mode === "reset"
                  ? "发送重置邮件"
                  : "登录"}
          </button>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setMode(mode === "signup" ? "login" : "signup");
                setError("");
                setNotice("");
              }}
            >
              {mode === "signup" ? "已有账号，去登录" : "注册新账号"}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setMode(mode === "reset" ? "login" : "reset");
                setError("");
                setNotice("");
              }}
            >
              {mode === "reset" ? "返回登录" : "忘记密码"}
            </button>
          </div>
        </form>
      )}
      {notice && (
        <p role="status" style={{ color: "#147A59", fontSize: 13, lineHeight: 1.7, marginTop: 16 }}>
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "#C1342C", fontSize: 13, lineHeight: 1.7, marginTop: 16 }}>
          {error}
        </p>
      )}
    </section>
  );
}
