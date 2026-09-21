import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import * as Crypto from "expo-crypto";
import { createApi } from "../core/api";
import { createRequestIdentity } from "../core/request-identity";
import type { Snapshot } from "../core/contracts";
import type {
  AuthInterruption,
  DraftRecoveryStore,
  DraftScope,
  RestoredDrafts,
} from "../core/draft-recovery";
import { apiUrl, getAuthClient, getSessionFence } from "../session";
import { colors as c, styles as s } from "../theme";

export type RecoveredSession = {
  scope: DraftScope;
  snapshot: Snapshot;
  drafts: RestoredDrafts;
};

export default function DraftRecoveryGate({
  scope,
  store,
  isCurrent,
  onRecovered,
  onDiscard,
  onExit,
}: {
  scope: DraftScope;
  store: DraftRecoveryStore;
  isCurrent: () => boolean;
  onRecovered: (value: RecoveredSession) => void;
  onDiscard: () => void;
  onExit: (reason: AuthInterruption | "user") => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const running = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      store.cancelRestore();
    };
  }, [store]);
  async function restore() {
    if (running.current || !isCurrent()) return;
    running.current = true;
    setBusy(true);
    setError("");
    let latest: Snapshot | null = null;
    const current = () => alive.current && isCurrent();
    try {
      const auth = getAuthClient(),
        fence = getSessionFence();
      const api = createApi(
        apiUrl,
        createRequestIdentity({
          owner: scope.owner,
          isCurrent: current,
          isFenceBlocked: () => fence.isBlocked(),
          getSession: async () =>
            auth
              ? auth.auth.getSession()
              : { data: { session: null }, error: null },
        }),
      );
      const result = await store.restoreExplicit({
        scope,
        confirmed: true,
        isCurrent: current,
        isFenceBlocked: () => fence.isBlocked(),
        verifyUser: async () => {
          const verified = await auth?.auth.getUser();
          if (verified?.error) throw verified.error;
          return verified?.data.user?.id ?? null;
        },
        loadWorkspace: async (owner, signal) => {
          const value = await api.load(owner, signal);
          latest = value;
          return value;
        },
        sha256: (value) =>
          Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
      });
      if (!current()) return;
      if (result.status === "restored" && latest) {
        onRecovered({
          scope: result.scope,
          snapshot: latest,
          drafts: result.drafts,
        });
      } else if (result.status === "empty") onDiscard();
      else if (result.status === "locked") {
        if (
          result.reason === "account-blocked" ||
          result.reason === "account-changed"
        )
          onExit(result.reason);
        else if (["identity", "fence"].includes(result.reason))
          onExit("reauthentication");
        else
          setError(
            "还无法确认云端状态。输入仍被保护，请检查网络后重试；不会自动保存或发送问题。",
          );
      }
    } catch {
      if (current())
        setError("暂时无法核对登录与云端状态。输入仍被保护，请稍后重试。");
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <DraftRecoveryPrompt
      busy={busy}
      error={error}
      onRestore={() => void restore()}
      onDiscard={() => {
        if (store.discardSealed(scope)) onDiscard();
      }}
      onExit={() => onExit("user")}
    />
  );
}

/** The same presentation can be exercised in an isolated fixture without Auth or network. */
export function DraftRecoveryPrompt({
  busy,
  error,
  onRestore,
  onDiscard,
  onExit,
}: {
  busy: boolean;
  error: string;
  onRestore: () => void;
  onDiscard: () => void;
  onExit: () => void;
}) {
  return (
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        padding: 24,
      }}
    >
      <View
        style={[
          s.card,
          { width: "100%", maxWidth: 520, alignSelf: "center", gap: 18 },
        ]}
      >
        <Text accessibilityRole="header" style={s.title}>
          接着上次的输入
        </Text>
        <Text style={s.secondary}>
          本次应用会话还有未确认保存的输入。选择恢复后，我们会重新验证当前账号，并先核对云端保存结果。
        </Text>
        <Text style={s.caption}>
          只恢复你输入的文字、链接和问题输入，不会自动提交。预览和 AI
          授权需要重新确认；关闭应用进程后，这些临时输入会消失。
        </Text>
        {!!error && (
          <View accessibilityRole="alert" style={s.error}>
            <Text style={s.errorText}>{error}</Text>
          </View>
        )}
        {busy && <ActivityIndicator color={c.brand} />}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onRestore}
          style={[s.button, busy && { opacity: 0.6 }]}
        >
          <Text style={s.buttonText}>
            {busy ? "正在验证并核对…" : "核对云端并恢复输入"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onDiscard}
          style={[s.button, s.softButton]}
        >
          <Text style={[s.buttonText, { color: c.ink }]}>
            放弃输入，进入工作区
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onExit}
          style={s.softButton}
        >
          <Text style={[s.secondary, { textAlign: "center", padding: 12 }]}>
            退出并清除当前会话
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
