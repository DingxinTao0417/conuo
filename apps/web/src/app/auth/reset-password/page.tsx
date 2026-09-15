"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { isCloudConfigured, updateCloudPassword } from "@/lib/cloud";

export default function ResetPasswordPage() {
  const [expectedUserId, setExpectedUserId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    let active = true;
    if (!isCloudConfigured()) return;
    void createClient()
      .auth.getUser()
      .then(({ data, error }) => {
        if (active) {
          setExpectedUserId(!error && data.user ? data.user.id : null);
          if (!data.user || error) setError("请先登录，或通过重置邮件中的链接打开此页面。");
        }
      })
      .catch(() => {
        if (active) setError("无法确认登录状态，请检查网络后重试。");
      });
    return () => {
      active = false;
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!expectedUserId) {
      setError("请先确认登录状态。");
      return;
    }
    if (password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await updateCloudPassword(password, expectedUserId);
      setPassword("");
      setConfirmation("");
      setDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "密码更新未完成。请重新发送重置邮件。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main style={{ maxWidth: 420, margin: "12vh auto", padding: 24 }}>
      <Link href="/" style={{ color: "#4B3FE3" }}>
        ← 返回 Conuo
      </Link>
      <h1 style={{ fontSize: 24, marginTop: 30 }}>设置新密码</h1>
      {!isCloudConfigured() ? (
        <p>当前尚未连接云端账号服务。</p>
      ) : done ? (
        <p role="status">密码已更新，可以返回工作区继续学习。</p>
      ) : (
        <form onSubmit={submit} style={{ display: "grid", gap: 16, marginTop: 24 }}>
          <label style={{ display: "grid", gap: 8 }}>
            新密码
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              style={{ padding: 12, border: "1px solid #E5E5E5", borderRadius: 8 }}
            />
          </label>
          <label style={{ display: "grid", gap: 8 }}>
            再次输入
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              style={{ padding: 12, border: "1px solid #E5E5E5", borderRadius: 8 }}
            />
          </label>
          <p style={{ color: "#737373", fontSize: 13 }}>至少 10 个字符。</p>
          <button
            type="submit"
            disabled={!expectedUserId || busy}
            style={{
              background: "#4B3FE3",
              color: "white",
              border: 0,
              borderRadius: 8,
              padding: 12,
            }}
          >
            {busy ? "正在保存…" : "更新密码"}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" style={{ color: "#C1342C", lineHeight: 1.7 }}>
          {error}
        </p>
      )}
    </main>
  );
}
