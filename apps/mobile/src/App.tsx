import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import type { DocumentPickerAsset } from "expo-document-picker";
import { extractPdfText, type InkTool } from "../modules/conuo-pdf-ink";
import PdfInkToolbar, { type PdfInkToolsState } from "./components/PdfInkToolbar";
import AnswerMarkdown from "./components/AnswerMarkdown";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Home,
  Library,
  LogOut,
  Plus,
  PanelLeft,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  UserRound,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { getAuthClient, getSessionFence, apiUrl } from "./session";
import { createApi } from "./core/api";
import { createRequestIdentity } from "./core/request-identity";
import { isTransientAuthError } from "./core/session-fence";
import {
  adoptSnapshot,
  blankWorkspace,
  createTextNote,
  notePreview,
  answerScope,
  readingBlocks,
  readingSource,
  type Answer,
  type Citation,
  type Snapshot,
  type Source,
} from "./core/contracts";
import { demoWorkspace } from "./demo";
import { colors as c, styles as s } from "./theme";
import WebImportSheet from "./components/WebImportSheet";
import DraftRecoveryGate, {
  type RecoveredSession,
} from "./components/DraftRecoveryGate";
import {
  authInterruptionReason,
  createDraftRecoveryStore,
  noteSaveReceipt,
  type AuthInterruption,
  type DraftPatch,
  type DraftRecoveryStore,
  type NoteReceipt,
  type RestoredDrafts,
} from "./core/draft-recovery";
import SourceReader from "./components/SourceReader";
import { createReaderSession } from "./core/reader";
import {
  assertPdfWorkspaceCapacity,
  buildPdfSource,
  validatePdfFile,
} from "./core/pdf-import";
import {
  createSupabaseOriginalUploadPort,
  uploadPdfOriginal,
} from "./core/original-upload";
import { saveImportedPdfWithCAS } from "./core/pdf-import-save";
import PdfImportSheet, {
  type PdfImportPhase,
} from "./components/PdfImportSheet";
import HomeOverview from "./components/HomeOverview";
import { useReducedMotion } from "./components/useReducedMotion";
import { useRestoredScroll } from "./components/useRestoredScroll";
import {
  appendAnswerConversation,
  applyReadingProgress,
  discussionFor,
  filterLibrarySources,
  listLocationKey,
  pruneDiscussions,
  prepareDiscussionQuestion,
  completeQuestionRequest,
  recoverableQuestions,
  sourceConversation,
  sourceStatusLabel,
  updateDiscussion,
  type Discussions,
  type PendingQuestions,
  type LearningLocation,
  type LearningTab,
} from "./core/learning-session";

type Login = { id: string; generation: number };
type Tab = LearningTab;
const tabs: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "学习概览", icon: Home },
  { id: "library", label: "资料库", icon: Library },
  { id: "knowledge", label: "笔记与知识", icon: BookOpen },
  { id: "account", label: "账号", icon: UserRound },
];
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请稍后重试。";
async function hashFileBytes(bytes: Uint8Array) {
  // expo-crypto's native bridge expects an actual TypedArray, not an
  // ArrayBuffer. Copying also detaches the hash input from FileSystem's
  // ArrayBufferLike backing store before the bridge receives it.
  const data = Uint8Array.from(bytes);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function Button({
  title,
  onPress,
  soft,
  disabled,
  icon: Icon,
}: {
  title: string;
  onPress: () => void;
  soft?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        s.button,
        soft && s.softButton,
        disabled && { opacity: 0.45 },
        pressed && !disabled && { opacity: 0.78 },
        focused && { borderWidth: 2, borderColor: c.brand },
      ]}
    >
      {Icon && <Icon size={17} color={soft ? c.ink : "white"} />}
      <Text style={[s.buttonText, soft && { color: c.ink }]}>{title}</Text>
    </Pressable>
  );
}
function IconButton({
  label,
  icon: Icon,
  onPress,
  disabled,
}: {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        s.iconButton,
        disabled && { opacity: 0.4 },
        pressed && { backgroundColor: c.purple },
        focused && { borderWidth: 2, borderColor: c.brand },
      ]}
    >
      <Icon size={21} color={c.ink} />
    </Pressable>
  );
}
function NavigationButton({
  id,
  label,
  icon: Icon,
  active,
  side,
  onPress,
}: {
  id: Tab;
  label: string;
  icon: LucideIcon;
  active: boolean;
  side: boolean;
  onPress: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      style={({ pressed }) => [
        side ? s.sideItem : s.tab,
        active &&
          (side
            ? s.sideActive
            : { backgroundColor: "#f4f1fd", borderRadius: 10 }),
        pressed && { opacity: 0.7 },
        focused && { borderWidth: 2, borderColor: c.brand, borderRadius: 9 },
      ]}
    >
      <Icon size={side ? 19 : 22} color={active ? c.brand : c.secondary} />
      <Text
        style={
          side
            ? [s.body, { fontSize: 14, color: active ? c.brand : c.secondary }]
            : [s.tabLabel, active && { color: c.brand }]
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}
function Brand() {
  return (
    <View style={s.row}>
      <View style={s.mark}>
        <BookOpen color="white" size={23} />
      </View>
      <Text style={s.brand}>Conuo</Text>
    </View>
  );
}
function ErrorBox({ text }: { text: string }) {
  return text ? (
    <View accessibilityRole="alert" style={s.error}>
      <Text style={s.errorText}>{text}</Text>
    </View>
  ) : null;
}
function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={s.empty}>
      <BookOpen size={34} color="#a8a4c5" />
      <Text style={s.section}>{title}</Text>
      <Text style={[s.secondary, { textAlign: "center", maxWidth: 330 }]}>
        {detail}
      </Text>
      {action}
    </View>
  );
}

export default function App() {
  const draftRecovery = useRef(createDraftRecoveryStore()).current;
  const [recoveryPrompt, setRecoveryPrompt] = useState(false);
  const [recovered, setRecovered] = useState<RecoveredSession | null>(null);
  const [session, setSession] = useState<Login | null>(null),
    [demo, setDemo] = useState(false),
    [booting, setBooting] = useState(true);
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    loginBusy = useRef(false),
    logoutBusy = useRef(false),
    authBlocked = useRef(false),
    verifiedId = useRef<string | null>(null);
  const [cleanupPending, setCleanupPending] = useState(false);
  const auth = useMemo(() => {
    try {
      return getAuthClient();
    } catch {
      return null;
    }
  }, []);
  const fence = useMemo(() => (auth ? getSessionFence() : null), [auth]);
  useEffect(() => {
    if (!auth) {
      setBooting(false);
      return;
    }
    let alive = true,
      run = 0;
    const verify = async () => {
      const ticket = ++run,
        identityGeneration = generation.current;
      const currentAttempt = () =>
        alive && ticket === run && identityGeneration === generation.current;
      try {
        let blocked = true;
        try {
          blocked = !fence || (await fence.isBlocked());
        } catch {
          if (currentAttempt()) {
            if (verifiedId.current) {
              void signOut("reauthentication");
              return;
            }
            authBlocked.current = true;
            setSession(null);
            setCleanupPending(true);
            setError("无法确认安全登录状态，请重试清理凭据后登录。");
          }
          return;
        }
        if (blocked) {
          if (currentAttempt()) {
            if (verifiedId.current) {
              void signOut("reauthentication");
              return;
            }
            authBlocked.current = true;
            setSession(null);
            setCleanupPending(true);
          }
          return;
        }
        const { data, error: problem } = await auth.auth.getUser();
        if (!currentAttempt() || authBlocked.current) return;
        if (problem && verifiedId.current && isTransientAuthError(problem)) {
          setError(
            "暂时无法重新验证登录。当前页面和草稿仍保留，请联网后再保存。",
          );
          return;
        }
        const id = problem ? null : (data.user?.id ?? null);
        if (!id && verifiedId.current) {
          void signOut("reauthentication");
          return;
        }
        if (id !== verifiedId.current) {
          if (verifiedId.current) draftRecovery.clear("account-changed");
          setRecovered(null);
          setRecoveryPrompt(false);
          verifiedId.current = id;
          generation.current++;
        }
        if (id) {
          draftRecovery.activate({ owner: id, generation: generation.current });
          if (draftRecovery.hasSealedDrafts()) setRecoveryPrompt(true);
        }
        setSession(id ? { id, generation: generation.current } : null);
        setError("");
      } catch {
        if (currentAttempt() && !authBlocked.current) {
          if (!verifiedId.current) setSession(null);
          setError(
            verifiedId.current
              ? "暂时无法重新验证登录。当前页面和草稿仍保留，请联网后再保存。"
              : "暂时无法验证登录，请检查网络后重试。",
          );
        }
      } finally {
        if (alive) setBooting(false);
      }
    };
    void verify();
    const {
      data: { subscription },
    } = auth.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        ++run;
        // SDK events carry no cause. Explicit exits have already cleared/sealed below.
        if (!logoutBusy.current && verifiedId.current) {
          draftRecovery.suspend({
            owner: verifiedId.current,
            generation: generation.current,
          });
          authBlocked.current = true;
          void fence?.block().catch(() => setCleanupPending(true));
          setError(
            "登录需要重新验证。未保存输入仅在本次应用会话内受保护，同账号重新登录后可选择恢复。",
          );
        }
        verifiedId.current = null;
        generation.current++;
        setSession(null);
        setRecovered(null);
        setRecoveryPrompt(false);
      } else if (event !== "INITIAL_SESSION")
        setTimeout(() => {
          if (alive) void verify();
        }, 0);
    });
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        if (!authBlocked.current) auth.auth.startAutoRefresh();
        void verify();
      } else auth.auth.stopAutoRefresh();
    });
    return () => {
      alive = false;
      ++run;
      subscription.unsubscribe();
      listener.remove();
      auth.auth.stopAutoRefresh();
    };
  }, [auth, fence]);
  async function login() {
    if (!auth || !fence || loginBusy.current || logoutBusy.current) return;
    loginBusy.current = true;
    authBlocked.current = true;
    generation.current++;
    setBusy(true);
    setError("");
    try {
      const attempt = await fence.block();
      const result = await auth.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      const signedIn = result.data.session;
      if (result.error || !signedIn)
        throw new Error("登录未完成，请核对邮箱、密码和网络连接。");
      const verified = await auth.auth.getUser(signedIn.access_token);
      if (
        verified.error ||
        !verified.data.user ||
        verified.data.user.id !== signedIn.user.id ||
        verified.data.user.id !== result.data.user?.id
      )
        throw new Error("登录身份未通过验证，请重新登录。");
      draftRecovery.clearIfDifferentOwner(verified.data.user.id);
      if (!(await fence.allowVerifiedLogin(attempt)))
        throw new Error("登录过程已取消，请重新登录。");
      authBlocked.current = false;
      verifiedId.current = verified.data.user.id;
      generation.current++;
      draftRecovery.activate({
        owner: verified.data.user.id,
        generation: generation.current,
      });
      setRecovered(null);
      setRecoveryPrompt(draftRecovery.hasSealedDrafts());
      setCleanupPending(false);
      setSession({ id: verified.data.user.id, generation: generation.current });
      if (AppState.currentState === "active") auth.auth.startAutoRefresh();
      setPassword("");
    } catch (cause) {
      authBlocked.current = true;
      setSession(null);
      setCleanupPending(true);
      setError(errorMessage(cause));
    } finally {
      loginBusy.current = false;
      setBusy(false);
    }
  }
  async function signOut(reason: AuthInterruption | "user" = "user") {
    if (reason === "reauthentication") {
      if (verifiedId.current)
        draftRecovery.suspend({
          owner: verifiedId.current,
          generation: generation.current,
        });
    } else draftRecovery.clear(reason);
    setRecovered(null);
    setRecoveryPrompt(false);
    if (logoutBusy.current || loginBusy.current) return;
    logoutBusy.current = true;
    // Invalidate the mounted workspace immediately; network errors never re-expose it.
    authBlocked.current = true;
    verifiedId.current = null;
    generation.current++;
    setSession(null);
    setDemo(false);
    setPassword("");
    setBusy(true);
    let failed = false;
    if (auth && fence) {
      auth.auth.stopAutoRefresh();
      try {
        await fence.block();
      } catch {
        failed = true;
      }
      try {
        const result = await auth.auth.signOut({ scope: "local" });
        const remaining = await auth.auth.getSession();
        // An unreachable revocation service may still allow SDK local cleanup.
        if (remaining.error || remaining.data.session)
          throw result.error ?? new Error("Session remains");
      } catch {
        failed = true;
      }
    }
    setCleanupPending(failed);
    setError(
      failed
        ? "工作区已关闭，但安全登录凭据清理尚未确认。请重试清理；完成前不会重新打开旧账号。"
        : reason === "reauthentication"
          ? "请重新验证登录。未保存输入仅保留在本次应用会话内，同账号登录后可选择恢复。"
          : reason === "account-blocked"
            ? "当前账号已停止访问，临时输入与会话已清除。"
            : "",
    );
    logoutBusy.current = false;
    setBusy(false);
  }
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root} edges={["top", "bottom"]}>
        <StatusBar style="dark" />
        {session && error ? <ErrorBox text={error} /> : null}
        {booting ? (
          <View style={s.empty}>
            <ActivityIndicator color={c.brand} />
            <Text style={s.secondary}>正在确认登录状态…</Text>
          </View>
        ) : session && recoveryPrompt ? (
          <DraftRecoveryGate
            key={`recovery-${session.id}-${session.generation}`}
            scope={{ owner: session.id, generation: session.generation }}
            store={draftRecovery}
            isCurrent={() =>
              !authBlocked.current &&
              verifiedId.current === session.id &&
              generation.current === session.generation
            }
            onExit={(reason) => void signOut(reason)}
            onDiscard={() => setRecoveryPrompt(false)}
            onRecovered={(value) => {
              if (
                authBlocked.current ||
                verifiedId.current !== value.scope.owner ||
                generation.current !== value.scope.generation
              )
                return;
              setRecovered(value);
              setRecoveryPrompt(false);
            }}
          />
        ) : demo || session ? (
          <WorkspaceScreen
            key={demo ? "demo" : `${session!.id}-${session!.generation}`}
            session={session}
            demo={demo}
            onExit={() => void signOut()}
            recovery={draftRecovery}
            recovered={demo ? null : recovered}
            isCurrentSession={() =>
              !!session &&
              !authBlocked.current &&
              verifiedId.current === session.id &&
              generation.current === session.generation
            }
            onAuthError={(cause) => {
              if (
                !session ||
                authBlocked.current ||
                verifiedId.current !== session.id ||
                generation.current !== session.generation
              )
                return;
              const reason = authInterruptionReason(cause);
              if (reason) void signOut(reason);
            }}
          />
        ) : (
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <ScrollView
              contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}
              keyboardShouldPersistTaps="handled"
            >
              <View style={s.login}>
                <Brand />
                <View style={{ gap: 8, marginVertical: 20 }}>
                  <Text style={s.title}>让知识，慢慢成为你的。</Text>
                  <Text style={s.secondary}>
                    从自己的资料出发，阅读、提问，留下新的理解。
                  </Text>
                </View>
                {auth ? (
                  <>
                    <TextInput
                      accessibilityLabel="邮箱"
                      placeholder="邮箱"
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="email"
                      value={email}
                      onChangeText={setEmail}
                      style={s.input}
                    />
                    <TextInput
                      accessibilityLabel="密码"
                      placeholder="密码"
                      secureTextEntry
                      autoComplete="current-password"
                      value={password}
                      onChangeText={setPassword}
                      style={s.input}
                      onSubmitEditing={() => void login()}
                    />
                    <Button
                      title={busy ? "正在登录…" : "登录 Conuo"}
                      onPress={() => void login()}
                      disabled={busy || !email.trim() || !password}
                    />
                    <Button
                      title="在网页版注册或找回密码"
                      soft
                      onPress={() =>
                        void Linking.openURL(apiUrl).catch(() =>
                          setError("无法打开浏览器，请手动访问 Conuo。"),
                        )
                      }
                    />
                  </>
                ) : (
                  <View style={s.card}>
                    <Text style={s.section}>
                      {Platform.OS === "web"
                        ? "客户端设计预览"
                        : "连接你的云端工作区"}
                    </Text>
                    <Text style={s.secondary}>
                      {Platform.OS === "web"
                        ? "这里展示 iPhone 与 iPad 的界面和交互，使用示例资料。真实账号登录请在 iOS 客户端中使用。"
                        : "当前构建尚未配置云端连接。开发者配置公开的服务地址与 Supabase 发布密钥后，即可使用已有账号登录。"}
                    </Text>
                  </View>
                )}
                <ErrorBox text={error} />
                {cleanupPending && auth && (
                  <Button
                    title={busy ? "正在处理登录状态…" : "重试清理登录凭据"}
                    soft
                    disabled={busy}
                    onPress={() =>
                      void signOut(
                        draftRecovery.hasSealedDrafts()
                          ? "reauthentication"
                          : "user",
                      )
                    }
                  />
                )}
                <Button
                  title="浏览示例工作区"
                  soft
                  icon={ArrowRight}
                  disabled={busy}
                  onPress={() => {
                    setError("");
                    setDemo(true);
                  }}
                />
                <Text style={[s.caption, { textAlign: "center" }]}>
                  资料属于你。AI 的回答，始终回到来源核对。
                </Text>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function WorkspaceScreen({
  session,
  demo,
  onExit,
  onAuthError,
  recovery,
  recovered,
  isCurrentSession,
}: {
  session: Login | null;
  demo: boolean;
  onExit: () => void;
  onAuthError: (cause: unknown) => void;
  recovery: DraftRecoveryStore;
  recovered: RecoveredSession | null;
  isCurrentSession: () => boolean;
}) {
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions(),
    wide = width >= 760;
  const [inkNamespace, setInkNamespace] = useState("demo");
  const [pdfInkTool, setPdfInkTool] = useState<InkTool>("pen");
  const [pdfZoomStep, setPdfZoomStep] = useState(0);
  const [pdfUndoToken, setPdfUndoToken] = useState(0);
  const [pdfRedoToken, setPdfRedoToken] = useState(0);
  const pdfInkTools = useMemo<PdfInkToolsState>(
    () => ({
      tool: pdfInkTool,
      setTool: setPdfInkTool,
      zoomStep: pdfZoomStep,
      zoomIn: () => setPdfZoomStep((value) => value + 1),
      zoomOut: () => setPdfZoomStep((value) => value - 1),
      undoToken: pdfUndoToken,
      redoToken: pdfRedoToken,
      undo: () => setPdfUndoToken((value) => value + 1),
      redo: () => setPdfRedoToken((value) => value + 1),
    }),
    [pdfInkTool, pdfZoomStep, pdfUndoToken, pdfRedoToken],
  );
  useEffect(() => {
    let cancelled = false;
    if (demo || !session) {
      setInkNamespace("demo");
      return () => {
        cancelled = true;
      };
    }
    void Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      session.id,
    ).then((digest) => {
      if (!cancelled) setInkNamespace(digest.slice(0, 32));
    });
    return () => {
      cancelled = true;
    };
  }, [demo, session?.id]);
  const flushProgressRef = useRef<() => void>(() => {});
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") flushProgressRef.current();
    });
    return () => {
      listener.remove();
      void flushProgressRef.current();
    };
  }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pdfImporting, setPdfImporting] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [highlightRequest, setHighlightRequest] = useState(0);
  const [tab, setTab] = useState<Tab>("home"),
    [snapshot, setSnapshot] = useState<Snapshot | null>(
      demo
        ? { data: demoWorkspace, revision: 1 }
        : (recovered?.snapshot ?? null),
    );
  const [loading, setLoading] = useState(!demo && !recovered),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [sourceId, setSourceId] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null),
    [showAI, setShowAI] = useState(false);
  const [asking, setAsking] = useState(false);
  const [, renderDiscussion] = useState(0);
  const [citation, setCitation] = useState<Citation | null>(null),
    [highlight, setHighlight] = useState<string | null>(null);
  const initialNote = recovered?.drafts.note;
  const [editor, setEditor] = useState(
      !!initialNote && initialNote.pendingState !== "matched",
    ),
    [title, setTitle] = useState(initialNote?.title ?? ""),
    [body, setBody] = useState(initialNote?.text ?? ""),
    [noteSpace, setNoteSpace] = useState(initialNote?.spaceId ?? "");
  const [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState(""),
    [discard, setDiscard] = useState(false);
  const [reconcilingNote, setReconcilingNote] = useState(false);
  const alive = useRef(true),
    askController = useRef<AbortController | null>(null),
    loadController = useRef<AbortController | null>(null);
  const saveBusy = useRef(false),
    pending = useRef<NoteReceipt | null>(
      initialNote?.pending &&
        !["matched", "missing"].includes(initialNote.pendingState ?? "")
        ? initialNote.pending
        : null,
    );
  const pendingPdfImports = useRef(new Map<string, Source>());
  const noteReceipt = useRef<NoteReceipt | undefined>(initialNote?.pending);
  const noteInput = useRef({
    title: initialNote?.title ?? "",
    text: initialNote?.text ?? "",
    spaceId: initialNote?.spaceId ?? "",
  });
  const [recoveredWeb, setRecoveredWeb] = useState<RestoredDrafts["web"]>(null);
  const [orphanQuestions, setOrphanQuestions] = useState<
    RestoredDrafts["questions"]
  >([]);
  // Async requests must read the latest explicit discard, not a render's old array.
  const orphanQuestionsRef = useRef<RestoredDrafts["questions"]>([]);
  const [showOrphanQuestions, setShowOrphanQuestions] = useState(false);
  const draftIdentity = useRef<{ id: string; now: string } | null>(
    initialNote?.identity ?? null,
  );
  const spaceIdentity = useRef<string | null>(null);
  const readerSession = useRef(createReaderSession());
  const discussions = useRef<Discussions>(new Map());
  const pendingQuestions = useRef<PendingQuestions>(new Map());
  const listPositions = useRef(new Map<string, number>());
  const noteReturn = useRef<(LearningLocation & { sourceId: string }) | null>(
    null,
  );
  const workspace = snapshot?.data ?? blankWorkspace(),
    source = sourceId ? readingSource(workspace, sourceId) : undefined;
  const spaces = workspace.spaces.filter((space) => !space.archived),
    activeSources = workspace.sources.filter((item) => !item.deletedAt);
  const activeNotes = workspace.notes.filter((item) => !item.deletedAt);
  const note = activeNotes.find((item) => item.id === noteId);
  // Async callbacks run outside the render cycle, so keep the newest snapshot
  // and workspace visible to them without a stale closure.
  const latest = useRef({ snapshot, workspace });
  latest.current = { snapshot, workspace };
  const readingDirty = useRef<{ readPage?: number; lastReadAt: string } | null>(
    null,
  );
  const readingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readingBusy = useRef(false);
  const historyBusy = useRef(false);
  const pendingHistory = useRef<
    Array<{ payload: ReturnType<typeof answerScope>; result: Answer }>
  >([]);
  const readingNativePdf =
    Platform.OS !== "web" && !!source && source.kind === "pdf" && !!source.storagePath;
  // Document mode never shows the global nav rail; the pages panel replaces it.
  const canShowSidebar = wide && !source;
  const sidebarVisible = canShowSidebar && !sidebarCollapsed;
  const [pagesPanelOpen, setPagesPanelOpen] = useState(false);
  useEffect(() => {
    if (!source) setPagesPanelOpen(false);
  }, [source]);
  pruneDiscussions(discussions.current, workspace);
  const discussion = source
    ? discussionFor(discussions.current, workspace, source)
    : null;
  const sourceScopeKey = discussion?.scopeKey ?? "";
  const historyRounds = source
    ? sourceConversation(workspace, source.id)
    : undefined;
  const question = discussion?.question ?? "";
  const answer = discussion?.answer ?? null;
  const askError = discussion?.error ?? "";
  const locationKey = listLocationKey({ tab, filter, search });
  function captureDraft(patch: DraftPatch) {
    if (!demo && session)
      recovery.capture(
        { owner: session.id, generation: session.generation },
        patch,
      );
  }
  function captureNote(patch: Partial<typeof noteInput.current> = {}) {
    noteInput.current = { ...noteInput.current, ...patch };
    captureDraft({
      note: {
        ...noteInput.current,
        identity: draftIdentity.current ?? undefined,
        pending: noteReceipt.current,
      },
    });
  }
  function clearNoteDraft() {
    pending.current = null;
    noteReceipt.current = undefined;
    noteInput.current = { title: "", text: "", spaceId: "" };
    captureDraft({ note: null });
  }
  function captureQuestions() {
    captureDraft({
      questions: recoverableQuestions(
        discussions.current,
        workspace,
        pendingQuestions.current,
        orphanQuestionsRef,
      ),
    });
  }
  const notebookRestore = useRestoredScroll({
    key: locationKey,
    enabled: !source && !note,
    read: () => listPositions.current.get(locationKey) ?? 0,
    write: (value) => listPositions.current.set(locationKey, value),
  });
  const answerRestore = useRestoredScroll({
    key: sourceScopeKey,
    enabled: !!source && showAI,
    resetToken: answer,
    read: () => discussion?.scrollOffset ?? 0,
    write: (value) => {
      if (source)
        updateDiscussion(discussions.current, source.id, sourceScopeKey, {
          scrollOffset: value,
        });
    },
  });
  function patchDiscussion(patch: Parameters<typeof updateDiscussion>[3]) {
    if (
      source &&
      updateDiscussion(discussions.current, source.id, sourceScopeKey, patch)
    ) {
      renderDiscussion((value) => value + 1);
      captureQuestions();
    }
  }
  function setQuestion(value: string) {
    patchDiscussion({ question: value, questionDirty: true, error: "" });
  }
  function revealAI() {
    setShowAI(true);
  }
  function hideAI() {
    answerRestore.capture();
    setShowAI(false);
  }
  function markReadingMove(page: number | undefined) {
    if (demo || !source) return;
    readingDirty.current = {
      readPage: page,
      lastReadAt: new Date().toISOString(),
    };
    if (readingTimer.current) clearTimeout(readingTimer.current);
    readingTimer.current = setTimeout(() => {
      void flushReadingProgress();
    }, 15_000);
  }
  async function flushReadingProgress() {
    if (demo || !api || !session || !source) return;
    if (readingTimer.current) clearTimeout(readingTimer.current);
    try {
      await commitReadingProgress();
    } catch (cause) {
      if (authInterruptionReason(cause)) {
        if (alive.current) onAuthError(cause);
        return;
      }
      // The attempt outcome is unknown or conflicted: re-read the authoritative
      // cloud snapshot, merge the same semantic move once, and retry once. A
      // second failure keeps the dirty state for the next flush, never a lie.
      try {
        const fresh = await api.load(session.id);
        if (!alive.current || !fresh.data) return;
        const patched = applyReadingProgress(
          fresh.data,
          source!.id,
          readingDirty.current ?? {
            readPage: undefined,
            lastReadAt: new Date().toISOString(),
          },
        );
        if (patched === fresh.data) return;
        const saved = await api.save(session.id, fresh, patched);
        readingDirty.current = null;
        if (alive.current)
          setSnapshot((previous) => adoptSnapshot(previous, saved));
      } catch (retryCause) {
        if (alive.current && authInterruptionReason(retryCause))
          onAuthError(retryCause);
      }
    }
  }
  async function commitReadingProgress() {
    if (readingBusy.current) return;
    const dirty = readingDirty.current;
    if (!dirty) return;
    const current = latest.current;
    if (current.snapshot === null) return;
    const sourceTarget = readingSource(current.workspace, source!.id);
    if (!sourceTarget) return;
    const data = applyReadingProgress(current.workspace, sourceTarget.id, dirty);
    if (data === current.workspace) return;
    readingBusy.current = true;
    try {
      const saved = await api!.save(session!.id, current.snapshot, data);
      readingDirty.current = null;
      if (alive.current) setSnapshot((previous) => adoptSnapshot(previous, saved));
    } finally {
      readingBusy.current = false;
    }
  }
  flushProgressRef.current = flushReadingProgress;
  /** Persist a completed answer as the source's cloud document conversation. */
  async function persistAnswerHistory(
    payload: ReturnType<typeof answerScope>,
    result: Answer,
  ) {
    if (demo || !api || !session) return;
    // A second answer can finish while the first workspace CAS save is still
    // in flight. Queue it instead of leaving the in-memory answer without a
    // cloud history record.
    if (historyBusy.current) {
      pendingHistory.current.push({ payload, result });
      return;
    }
    historyBusy.current = true;
    const requestId = payload.requestId;
    try {
      const current = latest.current;
      if (current.snapshot === null) return;
      const scopeSnapshot: Record<string, unknown> = { ...payload };
      delete scopeSnapshot.requestId;
      delete scopeSnapshot.question;
      const data = appendAnswerConversation(current.workspace, {
        source: readingSource(current.workspace, payload.sourceId!)!,
        question: payload.question,
        answer: result,
        spaceId: payload.spaceId,
        requestId,
        questionMessageId: Crypto.randomUUID(),
        scopeSnapshot,
        now: new Date().toISOString(),
      });
      if (data === current.workspace) return;
      const saved = await api.save(session.id, current.snapshot, data);
      if (alive.current)
        setSnapshot((previous) => adoptSnapshot(previous, saved));
    } catch (cause) {
      if (authInterruptionReason(cause)) {
        pendingHistory.current = [];
        if (alive.current) onAuthError(cause);
        return;
      }
      // Unknown or conflicted outcome: check the authoritative cloud state
      // before deciding. The in-memory answer always stays visible.
      try {
        const fresh = await api.load(session.id);
        if (!alive.current || !fresh.data) return;
        const scopeSnapshot: Record<string, unknown> = { ...payload };
        delete scopeSnapshot.requestId;
        delete scopeSnapshot.question;
        const target = readingSource(fresh.data, payload.sourceId!)!;
        const data = appendAnswerConversation(fresh.data, {
          source: target,
          question: payload.question,
          answer: result,
          spaceId: payload.spaceId,
          requestId,
          questionMessageId: Crypto.randomUUID(),
          scopeSnapshot,
          now: new Date().toISOString(),
        });
        if (data === fresh.data) return;
        const saved = await api.save(session.id, fresh, data);
        if (alive.current)
          setSnapshot((previous) => adoptSnapshot(previous, saved));
      } catch {
        if (alive.current)
          setNotice("回答已显示；云端问答历史暂未保存，将随下次操作重试。");
      }
    } finally {
      historyBusy.current = false;
      const next = pendingHistory.current.shift();
      if (next && alive.current) {
        void persistAnswerHistory(next.payload, next.result);
      }
    }
  }
  const api = useMemo(
    () =>
      demo
        ? null
        : createApi(
            apiUrl,
            createRequestIdentity({
              owner: session!.id,
              isCurrent: () => alive.current && isCurrentSession(),
              isFenceBlocked: () => getSessionFence().isBlocked(),
              getSession: async () => {
                const auth = getAuthClient();
                return auth
                  ? auth.auth.getSession()
                  : { data: { session: null }, error: null };
              },
            }),
          ),
    [demo, session?.id],
  );
  function handleError(cause: unknown) {
    if (!alive.current) return;
    if (authInterruptionReason(cause)) {
      onAuthError(cause);
      return;
    }
    setError(errorMessage(cause));
  }
  async function refresh() {
    if (demo || !api || !session || saveBusy.current) return;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setError("");
    try {
      const data = await api.load(session.id, controller.signal);
      if (alive.current && !controller.signal.aborted)
        setSnapshot((previous) => adoptSnapshot(previous, data));
    } catch (cause) {
      if (!controller.signal.aborted) handleError(cause);
    } finally {
      if (alive.current && loadController.current === controller)
        setLoading(false);
    }
  }
  async function saveImportedPdf(source: Source, spaceId: string) {
    if (!api || !session || !isCurrentSession())
      throw new Error("请重新登录后再保存这份 PDF。");
    const initial = latest.current.snapshot;
    if (!initial) throw new Error("云端资料尚未读取完成，请稍后重试。");
    try {
      const result = await saveImportedPdfWithCAS({
        owner: session.id,
        source,
        spaceId,
        initial,
        api,
        isCurrent: () => alive.current && isCurrentSession(),
        isAuthenticationError: (cause) => !!authInterruptionReason(cause),
        onSnapshot: (next) => {
          if (alive.current)
            setSnapshot((previous) => adoptSnapshot(previous, next));
        },
      });
      return { source: result.source, duplicate: result.duplicate };
    } catch (cause) {
      if (authInterruptionReason(cause)) {
        onAuthError(cause);
        throw new Error("登录状态已失效，请重新登录后核对资料库。");
      }
      throw cause;
    }
  }

  async function importPdfFile(
    asset: DocumentPickerAsset,
    spaceId: string,
    aiAllowed: boolean,
    onPhase: (phase: PdfImportPhase) => void,
  ) {
    if (demo) throw new Error("示例预览不能上传文件，请退出示例并登录真实账号。");
    if (!api || !session || !isCurrentSession())
      throw new Error("当前账号不可用，请重新登录后上传。");
    if (saveBusy.current) throw new Error("另一项资料保存仍在进行，请稍后再上传。");

    saveBusy.current = true;
    setSaving(true);
    loadController.current?.abort();
    setLoading(false);
    let stage = "准备文件";
    try {
      stage = "读取文件元数据";
      onPhase("reading");
      const file = new File(asset.uri);
      const declaredSize =
        Number.isSafeInteger(asset.size) && (asset.size ?? 0) > 0
          ? asset.size!
          : file.size;
      const filename = validatePdfFile(asset.name, declaredSize);
      stage = "读取文件内容";
      const bytes = await file.bytes();
      validatePdfFile(filename, bytes.byteLength);
      if (declaredSize > 0 && declaredSize !== bytes.byteLength)
        throw new Error("所选文件大小在读取时发生变化，请重新选择后再试。");
      stage = "计算文件指纹";
      const hash = await hashFileBytes(bytes);
      const current = latest.current.workspace;
      const existing = current.sources.find(
        (item) => !item.deletedAt && item.kind === "pdf" && item.hash === hash,
      );

      if (existing?.storagePath) {
        onPhase("saving");
        const saved = await saveImportedPdf(existing, spaceId);
        pendingPdfImports.current.delete(hash);
        return { source: saved.source, duplicate: true };
      }

      const pendingSource = pendingPdfImports.current.get(hash);
      let source = pendingSource;
      if (existing && (!pendingSource || pendingSource.id !== existing.id))
        source = {
          ...existing,
          mime: "application/pdf",
          size: bytes.byteLength,
          hash,
        };
      if (!source) {
        let pageCount = 0;
        let pages: string[] = [];
        let parseError: string | undefined;
        try {
          stage = "提取 PDF 页面文字";
          const extracted = await extractPdfText(asset.uri);
          pageCount = Number.isSafeInteger(extracted.pageCount)
            ? Math.max(0, extracted.pageCount)
            : 0;
          pages = Array.isArray(extracted.pages)
            ? extracted.pages.map((text) => (typeof text === "string" ? text : ""))
            : [];
        } catch (cause) {
          parseError =
            cause instanceof Error ? cause.message : "PDFKit 无法读取这份文件。";
        }
        source = buildPdfSource({
          id: existing?.id ?? Crypto.randomUUID(),
          versionId: existing?.versionId ?? Crypto.randomUUID(),
          filename,
          size: bytes.byteLength,
          hash,
          spaceId,
          aiAllowed: aiAllowed && current.aiEnabled,
          pageCount,
          pages: pages.map((text, index) => ({ page: index + 1, text })),
          ...(parseError ? { parseError } : {}),
          createId: Crypto.randomUUID,
        });
        pendingPdfImports.current.set(hash, source);
      } else {
        source = {
          ...source,
          mime: "application/pdf",
          size: bytes.byteLength,
          hash,
          aiAllowed: existing ? existing.aiAllowed : aiAllowed && current.aiEnabled,
        };
      }

      const auth = getAuthClient();
      if (!auth) throw new Error("当前构建尚未配置云端连接，请重新启动移动端开发构建。");
      stage = "检查工作区容量";
      assertPdfWorkspaceCapacity(latest.current.workspace, source, spaceId);
      onPhase("uploading");
      stage = "上传 PDF 原件";
      const port = createSupabaseOriginalUploadPort(auth, hashFileBytes);
      const storagePath = await uploadPdfOriginal(source, bytes, session.id, port);
      source = { ...source, storagePath, originalMissing: false };
      pendingPdfImports.current.set(hash, source);
      if (!alive.current || !isCurrentSession())
        throw new Error("账号已改变，已停止保存这份 PDF。");

      onPhase("saving");
      stage = "确认资料库保存";
      const saved = await saveImportedPdf(source, spaceId);
      pendingPdfImports.current.delete(hash);
      setNotice(
        saved.duplicate
          ? "相同 PDF 已核对；资料库已使用现有资料。"
          : "PDF 原件和资料记录已确认保存到云端。",
      );
      return saved;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "未知错误";
      throw new Error(`${stage}失败：${message}`);
    } finally {
      saveBusy.current = false;
      if (alive.current) setSaving(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    if (!recovered) void refresh();
    else {
      const drafts = recovered.drafts;
      if (drafts.note?.pendingState === "matched") {
        clearNoteDraft();
        setTitle("");
        setBody("");
        setNoteId(drafts.note.pending!.id);
        setTab("knowledge");
        setNotice("已核对：之前的笔记已保存到云端。");
      } else if (drafts.note) {
        setSaveError(
          drafts.note.pendingState === "changed" ||
            drafts.note.pendingState === "deleted"
            ? "云端内容或状态已改变。草稿已保留，请核对后处理；不会覆盖或恢复已删除内容。"
            : !drafts.note.targetAvailable
              ? "原知识库已不可用，请重新选择保存位置。"
              : drafts.note.pendingState === "missing"
                ? "已核对云端，未找到本次笔记。输入与原身份已保留，可由你再次保存。"
                : "已恢复未保存输入，请检查后保存。",
        );
      }
      if (drafts.web) setRecoveredWeb(drafts.web);
      const unavailable: RestoredDrafts["questions"] = [];
      for (const item of drafts.questions) {
        const target = readingSource(workspace, item.sourceId);
        if (!target || item.context === "source-unavailable") {
          unavailable.push(item);
          continue;
        }
        const current = discussionFor(discussions.current, workspace, target);
        updateDiscussion(discussions.current, target.id, current.scopeKey, {
          question: item.question,
          questionDirty: true,
          answer: null,
          answerQuestion: "",
          contextNotice:
            item.kind === "unanswered"
              ? "已恢复未获得回答的问题，没有自动重新发送。请核对当前资料版本和 AI 授权后再发送。"
              : "已恢复未发送问题。请核对当前资料版本和 AI 授权后再发送。",
        });
      }
      orphanQuestionsRef.current = unavailable;
      setOrphanQuestions(unavailable);
      if (drafts.questions.length)
        setNotice(
          "未发送或未获得回答的问题已恢复；之前的回答未保留，也没有重新发送请求。",
        );
    }
    return () => {
      alive.current = false;
      askController.current?.abort();
      loadController.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (sourceId && !source) {
      askController.current?.abort();
      setSourceId(null);
      setError("这份资料已被移除，请从当前资料库重新选择。");
    }
  }, [snapshot, sourceId]);
  useEffect(() => {
    askController.current?.abort();
    setAsking(false);
    setCitation(null);
    setHighlight(null);
  }, [
    sourceId,
    source?.versionId,
    source?.aiAllowed,
    workspace.aiEnabled,
    sourceScopeKey,
  ]);
  function navigate(next: Tab) {
    notebookRestore.capture();
    answerRestore.capture();
    askController.current?.abort();
    setAsking(false);
    void flushReadingProgress();
    setSourceId(null);
    setNoteId(null);
    noteReturn.current = null;
    setTab(next);
    setFilter("all");
    setSearch("");
    setShowAI(false);
  }
  function openLibrary(spaceId = "all") {
    navigate("library");
    setFilter(spaceId);
  }
  function returnFromSource() {
    answerRestore.capture();
    askController.current?.abort();
    setAsking(false);
    void flushReadingProgress();
    setSourceId(null);
    setShowAI(false);
  }
  function openSource(item: Source) {
    notebookRestore.capture();
    answerRestore.capture();
    askController.current?.abort();
    setAsking(false);
    setHighlight(null);
    setNoteId(null);
    noteReturn.current = null;
    setSourceId(item.id);
    setShowAI(false);
  }
  async function ask() {
    if (!source || asking) return;
    const controller = new AbortController();
    askController.current?.abort();
    askController.current = controller;
    setAsking(true);
    patchDiscussion({ error: "" });
    const requestedScope = sourceScopeKey;
    const requestedSource = source.id;
    const requestId = Crypto.randomUUID();
    try {
      const payload = prepareDiscussionQuestion(
        discussions.current,
        workspace,
        source,
        requestId,
      );
      pendingQuestions.current.set(requestedSource, {
        requestId,
        scopeKey: requestedScope,
        versionId: source.versionId,
        question,
      });
      captureQuestions();
      const result: Answer = demo
        ? {
            mode: "extractive",
            content: `## 从原文开始\n\n${source.chunks[0].text}\n\n### 给自己一个小练习\n\n合上资料，用自己的话解释这段内容，再回到下方来源核对。\n\n> 这是示例回答，没有调用 AI。`,
            citations: [
              {
                sourceId: source.id,
                versionId: source.versionId,
                chunkId: source.chunks[0].id,
                section: source.chunks[0].section,
                page: source.chunks[0].page,
                title: source.title,
                quote: source.chunks[0].text,
              },
            ],
          }
        : await api!.ask(session!.id, payload, controller.signal);
      if (
        alive.current &&
        !controller.signal.aborted &&
        updateDiscussion(discussions.current, requestedSource, requestedScope, {
          answer: result,
          answerQuestion: payload.question,
          scrollOffset: 0,
          error: "",
        })
      ) {
        completeQuestionRequest(
          pendingQuestions.current,
          requestedSource,
          requestId,
        );
        captureQuestions();
        renderDiscussion((value) => value + 1);
        void persistAnswerHistory(payload, result);
      }
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) {
        if (
          updateDiscussion(
            discussions.current,
            requestedSource,
            requestedScope,
            { error: errorMessage(cause) },
          )
        )
          renderDiscussion((value) => value + 1);
        if (authInterruptionReason(cause)) onAuthError(cause);
      }
    } finally {
      if (alive.current && askController.current === controller)
        setAsking(false);
    }
  }
  function startNote() {
    clearNoteDraft();
    draftIdentity.current = null;
    setTitle("");
    setBody("");
    setSaveError("");
    noteReturn.current = source
      ? { sourceId: source.id, tab, filter, search }
      : null;
    const targetSpace =
      source?.spaceIds.find((id) => spaces.some((space) => space.id === id)) ??
      (filter !== "all" && spaces.some((space) => space.id === filter)
        ? filter
        : (spaces[0]?.id ?? ""));
    setNoteSpace(targetSpace);
    captureNote({ title: "", text: "", spaceId: targetSpace });
    setEditor(true);
  }
  function openSavedNote(id: string) {
    notebookRestore.capture();
    answerRestore.capture();
    askController.current?.abort();
    setAsking(false);
    setSourceId(null);
    setNoteId(id);
    setTab("knowledge");
  }
  function returnFromNote() {
    setNoteId(null);
    const origin = noteReturn.current;
    noteReturn.current = null;
    if (origin && readingSource(workspace, origin.sourceId)) {
      setTab(origin.tab);
      setFilter(origin.filter);
      setSearch(origin.search);
      setSourceId(origin.sourceId);
    }
  }
  function closeEditor() {
    if (saveBusy.current) return;
    if (title.trim() || body.trim() || pending.current) setDiscard(true);
    else setEditor(false);
  }
  async function saveNote() {
    if (saveBusy.current || !snapshot || pending.current) return;
    saveBusy.current = true;
    loadController.current?.abort();
    setLoading(false);
    setSaving(true);
    setSaveError("");
    try {
      draftIdentity.current ??= {
        id: Crypto.randomUUID(),
        now: new Date().toISOString(),
      };
      const { id, now } = draftIdentity.current;
      const data = createTextNote(workspace, {
        id,
        spaceId: noteSpace,
        title,
        text: body,
        now,
      });
      const created = data.notes.find((item) => item.id === id)!;
      const receipt = await noteSaveReceipt(created, (value) =>
        Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
      );
      if (!alive.current) return;
      pending.current = receipt;
      noteReceipt.current = receipt;
      captureNote();
      const next = demo
        ? { data, revision: snapshot.revision + 1 }
        : await api!.save(session!.id, snapshot, data);
      if (!alive.current) return;
      clearNoteDraft();
      setSnapshot((previous) => adoptSnapshot(previous, next));
      setEditor(false);
      setTitle("");
      setBody("");
      openSavedNote(created.id);
      setNotice(demo ? "示例笔记仅保留在本次预览中。" : "笔记已保存到云端。");
    } catch (cause) {
      if (alive.current) setSaveError(errorMessage(cause));
      if (alive.current && authInterruptionReason(cause)) onAuthError(cause);
    } finally {
      saveBusy.current = false;
      if (alive.current) setSaving(false);
    }
  }
  async function reconcileNote() {
    if (saveBusy.current || !pending.current || !api || !session) return;
    saveBusy.current = true;
    setReconcilingNote(true);
    setSaving(true);
    setSaveError("");
    try {
      const latest = await api.load(session.id);
      if (!alive.current) return;
      const expected = pending.current,
        found = latest.data?.notes.find((item) => item.id === expected?.id);
      const actual =
        found && !found.deletedAt
          ? await noteSaveReceipt(found, (value) =>
              Crypto.digestStringAsync(
                Crypto.CryptoDigestAlgorithm.SHA256,
                value,
              ),
            )
          : null;
      if (!alive.current) return;
      if (
        found &&
        !found.deletedAt &&
        actual?.fingerprint === expected.fingerprint
      ) {
        clearNoteDraft();
        setSnapshot(latest);
        setEditor(false);
        setTitle("");
        setBody("");
        setNotice("已核对：笔记已保存到云端。");
        openSavedNote(found.id);
      } else if (found) {
        setSaveError(
          "云端已有不同版本，请在网页版核对。当前草稿仍保留，请复制正文后再离开。",
        );
      } else {
        pending.current = null;
        setSnapshot(latest);
        setSaveError(
          "已读取最新云端资料，未发现这篇笔记。草稿保留，你可以再次点击保存。",
        );
      }
    } catch (cause) {
      if (alive.current) setSaveError(errorMessage(cause));
      if (alive.current && authInterruptionReason(cause)) onAuthError(cause);
    } finally {
      saveBusy.current = false;
      if (alive.current) {
        setSaving(false);
        setReconcilingNote(false);
      }
    }
  }
  async function createSpace() {
    if (!snapshot || saveBusy.current) return;
    // First-use creation is explicit. Failed loads never turn into an empty save.
    saveBusy.current = true;
    loadController.current?.abort();
    setLoading(false);
    setSaving(true);
    setError("");
    try {
      spaceIdentity.current ??= Crypto.randomUUID();
      if (workspace.spaces.some((item) => item.id === spaceIdentity.current))
        return;
      const data = {
        ...workspace,
        spaces: [
          ...workspace.spaces,
          {
            id: spaceIdentity.current,
            name: "我的学习空间",
            goal: "",
            color: "#6353c7",
            archived: false,
            createdAt: new Date().toISOString(),
          },
        ],
      };
      const next = demo
        ? { data, revision: snapshot.revision + 1 }
        : await api!.save(session!.id, snapshot, data);
      if (alive.current) {
        setSnapshot((previous) => adoptSnapshot(previous, next));
        setNotice(demo ? "示例空间已创建。" : "学习空间已保存到云端。");
      }
    } catch (cause) {
      handleError(cause);
    } finally {
      saveBusy.current = false;
      if (alive.current) setSaving(false);
    }
  }
  function requestPdfImport() {
    if (Platform.OS === "web") {
      setNotice("原生 PDF 文件导入请在 iOS 客户端中使用。");
      return;
    }
    if (demo) {
      setError("示例模式不连接云端；退出示例并登录后即可上传 PDF。");
      return;
    }
    setError("");
    setPdfImporting(true);
  }
  const filteredSources = filterLibrarySources(workspace, filter, search);
  const docRow = (item: Source) => (
    <Pressable
      key={item.id}
      accessibilityRole="button"
      accessibilityLabel={`阅读 ${item.title}`}
      onPress={() => openSource(item)}
      style={s.docRow}
    >
      <View
        style={[
          s.fileIcon,
          { backgroundColor: item.kind === "pdf" ? "#fdeff2" : c.green },
        ]}
      >
        <FileText
          size={21}
          color={item.kind === "pdf" ? "#b04f63" : "#287b69"}
        />
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text numberOfLines={2} style={s.docTitle}>
          {item.title}
        </Text>
        <Text style={s.caption}>
          {item.kind.toUpperCase()} · {sourceStatusLabel(item)}
          {item.tags.length ? ` · ${item.tags.slice(0, 2).join(" / ")}` : ""}
        </Text>
      </View>
      <ChevronRight size={17} color={c.muted} />
    </Pressable>
  );
  const nav = (side = false) =>
    tabs.map(({ id, label, icon }) => (
      <NavigationButton
        key={id}
        id={id}
        label={label}
        icon={icon}
        active={tab === id}
        side={side}
        onPress={() => navigate(id)}
      />
    ));
  const notebook = (
    <ScrollView
      ref={notebookRestore.ref}
      contentContainerStyle={s.content}
      scrollEventThrottle={32}
      onScroll={notebookRestore.onScroll}
      onScrollBeginDrag={notebookRestore.onScrollBeginDrag}
      onLayout={notebookRestore.onLayout}
      onContentSizeChange={notebookRestore.onContentSizeChange}
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={() => void refresh()}
          tintColor={c.brand}
        />
      }
    >
      <View style={s.spread}>
        {canShowSidebar && (
          <IconButton
            label={sidebarVisible ? "收起导航侧栏" : "展开导航侧栏"}
            icon={PanelLeft}
            onPress={() => setSidebarCollapsed((value) => !value)}
          />
        )}
        <View style={{ gap: 5, flex: 1 }}>
          <Text style={s.title}>
            {tab === "home"
              ? "学习概览"
              : tab === "library"
                ? "我的资料库"
                : tab === "knowledge"
                  ? "笔记与知识"
                  : "账号与偏好"}
          </Text>
          <Text style={s.secondary}>
            {tab === "home"
              ? activeSources.length
                ? "从上次停下的地方，继续往前。"
                : "从一份资料开始，留下自己的理解。"
              : tab === "library"
                ? "每一份资料，都有自己的位置。"
                : tab === "knowledge"
                  ? "留下理解，让知识连接起来。"
                  : "管理你的学习工作区。"}
          </Text>
        </View>
        {tab === "library" && snapshot && (
          <View style={s.row}>
            <IconButton
              label="上传 PDF 文件"
              icon={Upload}
              onPress={requestPdfImport}
            />
            <IconButton
              label="添加网页资料"
              icon={Plus}
              onPress={() => setImporting(true)}
            />
          </View>
        )}
        {tab !== "account" && !demo && (
          <IconButton
            label="刷新云端资料"
            icon={RefreshCw}
            onPress={() => void refresh()}
          />
        )}
      </View>
      <ErrorBox text={error} />
      {notice ? (
        <Pressable
          onPress={() => setNotice("")}
          style={[s.card, { backgroundColor: c.green, padding: 12 }]}
        >
          <Text style={s.secondary}>{notice}</Text>
        </Pressable>
      ) : null}
      {loading && !snapshot ? (
        <View style={s.empty}>
          <ActivityIndicator color={c.brand} />
          <Text style={s.secondary}>正在读取云端资料…</Text>
        </View>
      ) : !snapshot ? (
        <Empty
          title="暂时无法读取资料"
          detail="请检查网络后重试。你的云端内容不会被空白工作区覆盖。"
          action={<Button title="重新连接" onPress={() => void refresh()} />}
        />
      ) : (
        <>
          {tab === "home" && (
            <HomeOverview
              workspace={workspace}
              onOpenSource={openSource}
              onOpenLibrary={openLibrary}
              onCreateNote={startNote}
              onImport={() => setImporting(true)}
              onImportFile={requestPdfImport}
              onCreateSpace={() => void createSpace()}
              creatingSpace={saving}
              renderSource={docRow}
            />
          )}
          {tab === "library" && (
            <>
              <View style={s.search}>
                <Search size={19} color={c.muted} />
                <TextInput
                  accessibilityLabel="搜索资料"
                  placeholder="搜索标题、标签…"
                  value={search}
                  onChangeText={(value) => {
                    setSearch(value);
                  }}
                  style={s.searchInput}
                />
                {!!search && (
                  <IconButton
                    label="清除搜索"
                    icon={X}
                    onPress={() => {
                      setSearch("");
                    }}
                  />
                )}
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
              >
                {[
                  { id: "all", name: "全部资料" },
                  { id: "inbox", name: "收件箱" },
                  ...spaces,
                ].map((space) => (
                  <Pressable
                    key={space.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: filter === space.id }}
                    onPress={() => {
                      setFilter(space.id);
                    }}
                    style={[s.chip, filter === space.id && s.selectedChip]}
                  >
                    <Text
                      style={[
                        s.label,
                        filter === space.id && { color: c.brand },
                      ]}
                    >
                      {space.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              <View>
                <Text style={s.caption}>{filteredSources.length} 份资料</Text>
                {filteredSources.map(docRow)}
                {!filteredSources.length && (
                  <Empty
                    title={
                      search.trim()
                        ? "没有找到相关资料"
                        : filter === "inbox"
                          ? "收件箱是空的"
                          : filter !== "all"
                            ? "这个知识库还没有资料"
                            : "还没有资料"
                    }
                    detail={
                      search.trim()
                        ? "试试更短的关键词，或清除搜索查看当前范围。"
                        : filter === "inbox"
                          ? "尚未归入知识库的资料会出现在这里。可以先收藏一个网页链接。"
                          : "上传 PDF 原件，或添加网页链接；资料会同步到你的云端工作区。"
                    }
                    action={
                      search.trim() ? (
                        <Button
                          title="清除搜索"
                          soft
                          onPress={() => {
                            setSearch("");
                          }}
                        />
                      ) : (
                        <View style={[s.row, { flexWrap: "wrap" }]}>
                          <Button
                            title="上传 PDF"
                            icon={Upload}
                            onPress={requestPdfImport}
                          />
                          <Button
                            title="添加网页资料"
                            icon={Plus}
                            soft
                            onPress={() => setImporting(true)}
                          />
                        </View>
                      )
                    }
                  />
                )}
              </View>
            </>
          )}
          {tab === "knowledge" && (
            <>
              <Button
                title="新建笔记"
                icon={Plus}
                onPress={startNote}
                disabled={!spaces.length}
              />
              {activeNotes.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.kind === "knowledge" ? "知识页" : "笔记"}：${item.title || "未命名笔记"}，${item.status === "draft" ? "待审核" : "已保存"}`}
                  onPress={() => {
                    notebookRestore.capture();
                    noteReturn.current = null;
                    setNoteId(item.id);
                  }}
                  style={s.card}
                >
                  <View style={s.row}>
                    <View
                      style={[
                        s.fileIcon,
                        {
                          backgroundColor:
                            item.kind === "knowledge" ? c.blue : c.green,
                          height: 36,
                          width: 36,
                        },
                      ]}
                    >
                      <BookOpen size={18} color={c.brand} />
                    </View>
                    <Text style={s.caption}>
                      {item.kind === "knowledge" ? "知识页" : "笔记"} ·{" "}
                      {item.status === "draft" ? "待审核" : "已保存"}
                    </Text>
                  </View>
                  <Text style={s.section}>{item.title}</Text>
                  <Text numberOfLines={3} style={s.secondary}>
                    {notePreview(item.content)}
                  </Text>
                </Pressable>
              ))}
              {!activeNotes.length && (
                <Empty
                  title="把你的理解写下来"
                  detail="笔记保存在云端，可以在网页版继续编辑。"
                />
              )}
            </>
          )}
          {tab === "account" && (
            <>
              <View style={s.card}>
                <Text style={s.section}>
                  {demo ? "示例工作区" : "已登录 Conuo"}
                </Text>
                <Text style={s.secondary}>
                  {demo
                    ? "示例资料用于预览界面，退出后不保留。"
                    : "正式资料存放在云端。当前客户端支持网页收集、PDF 上传、正文阅读、资料问答和新建文本笔记。"}
                </Text>
              </View>
              <View style={s.card}>
                <Text style={s.section}>阅读与保存</Text>
                <Text style={s.secondary}>
                  正文可选中复制；AI
                  回答附带来源。尚未发送的问题和未保存笔记仅保留在当前会话，离开应用前请完成保存。
                </Text>
                <Text style={s.secondary}>
                  原生 PDF 原件页面阅读、DOCX / Markdown / TXT 导入和复杂编辑可在网页版继续。PDF 手写、原生分享和离线资料库尚未启用。
                </Text>
              </View>
              <Button
                title="打开 Conuo 网页版"
                soft
                onPress={() =>
                  void Linking.openURL(apiUrl).catch(() =>
                    setError("无法打开浏览器。"),
                  )
                }
              />
              <Button
                title={demo ? "退出示例预览" : "退出登录"}
                soft
                icon={LogOut}
                onPress={() =>
                  recoverableQuestions(
                    discussions.current,
                    workspace,
                    pendingQuestions.current,
                  ).length + orphanQuestions.length
                    ? setConfirmExit(true)
                    : onExit()
                }
              />
            </>
          )}
        </>
      )}
    </ScrollView>
  );
  const aiPanel = (
    <KeyboardAvoidingView
      style={s.aiPanel}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={s.aiHeader}>
        <View style={s.spread}>
          <View style={s.row}>
            <View style={s.aiIcon}>
              <Sparkles size={15} color={c.brand} />
            </View>
            <Text style={s.aiTitle}>问 AI</Text>
          </View>
          <IconButton label="收起 AI" icon={X} onPress={hideAI} />
        </View>
      </View>
      <ScrollView
        ref={answerRestore.ref}
        contentContainerStyle={{ padding: 16, gap: 14 }}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={32}
        onLayout={answerRestore.onLayout}
        onContentSizeChange={answerRestore.onContentSizeChange}
        onScroll={answerRestore.onScroll}
        onScrollBeginDrag={answerRestore.onScrollBeginDrag}
      >
        {!!historyRounds &&
          historyRounds.messages.filter((item) => item.role === "assistant")
            .length > 0 && (
            <View style={s.aiHistory}>
              {historyRounds.messages
                .filter((item) => item.role === "assistant")
                .slice(-3)
                .map((item) => {
                  const attempt = item.attempt as
                    | { questionMessageId?: string }
                    | undefined;
                  const pair = historyRounds.messages.find(
                    (candidate) => candidate.id === attempt?.questionMessageId,
                  );
                  return (
                    <View key={item.id} style={s.aiHistoryItem}>
                      <Text numberOfLines={1} style={s.aiHistoryQ}>
                        {pair?.content ?? "…"}
                      </Text>
                      <Text numberOfLines={2} style={s.aiHistoryA}>
                        {item.content.replace(/\s+/g, " ").slice(0, 100)}
                      </Text>
                    </View>
                  );
                })}
            </View>
          )}
        {!!discussion?.contextNotice && (
          <View style={s.aiNotice}>
            <Text accessibilityLiveRegion="polite" style={s.aiNoticeText}>
              {discussion.contextNotice}
            </Text>
          </View>
        )}
        {!answer && !asking && (
          <View style={s.aiPrompts}>
            {["核心观点是什么？", "解释最重要的概念", "举例说明"].map((text) => (
              <Pressable
                key={text}
                accessibilityRole="button"
                onPress={() => setQuestion(text)}
                style={s.aiChip}
              >
                <Text style={s.aiChipText}>{text}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {asking && (
          <View style={s.row}>
            <ActivityIndicator size="small" color={c.brand} />
            <Text style={s.caption}>思考中…</Text>
          </View>
        )}
        <ErrorBox text={askError} />
        {answer && (
          <>
            {!!discussion?.answerQuestion && (
              <View style={s.aiQuestion}>
                <Text numberOfLines={3} style={s.aiQuestionText}>
                  {discussion.answerQuestion}
                </Text>
              </View>
            )}
            <AnswerMarkdown>{answer.content}</AnswerMarkdown>
            {answer.citations.length > 0 && (
              <Text style={s.aiCiteTitle}>引用</Text>
            )}
            {answer.citations.map((item, index) => (
              <Pressable
                key={`${item.chunkId}-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`引用 ${index + 1}：${item.title}${item.page ? `，原文第 ${item.page} 页` : ""}`}
                accessibilityHint="打开原文并定位到这条引用"
                onPress={() => setCitation(item)}
                style={s.aiCite}
              >
                <Text style={s.aiCiteLabel}>
                  [{index + 1}] {item.title}
                  {item.page ? ` · ${item.page}` : ""}
                </Text>
                <Text numberOfLines={2} style={s.aiCiteQuote}>
                  {item.quote}
                </Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="写下我的理解"
              disabled={!spaces.length}
              onPress={startNote}
              style={[s.aiChip, !spaces.length && { opacity: 0.45 }]}
            >
              <Text style={s.aiChipText}>写下我的理解</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
      <View style={s.composer}>
        <View style={s.aiInputBox}>
          <TextInput
            accessibilityLabel="向 AI 提问"
            multiline
            placeholder="输入问题…"
            placeholderTextColor={c.muted}
            value={question}
            onChangeText={setQuestion}
            maxLength={2000}
            style={s.aiInput}
          />
          {asking ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="停止回答"
              onPress={() => {
                askController.current?.abort();
                setAsking(false);
                patchDiscussion({ error: "已停止本次回答。" });
              }}
              style={s.aiSend}
            >
              <Square size={13} fill={c.white} color={c.white} />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="发送问题"
              disabled={!question.trim()}
              onPress={() => void ask()}
              style={[s.aiSend, !question.trim() && { backgroundColor: "#d6d1f7" }]}
            >
              <ArrowUp size={15} color={c.white} />
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
  return (
    <View style={{ flex: 1 }}>
      {demo && (
        <View style={s.banner}>
          <Text style={s.bannerText}>
            演示模式 · 示例资料 · 不连接云端，也不调用 AI
          </Text>
        </View>
      )}
      {(recoveredWeb || orphanQuestions.length > 0) && (
        <View style={[s.banner, { gap: 8 }]}>
          <Text style={s.bannerText}>已恢复本次会话的未保存输入</Text>
          {recoveredWeb && (
            <Button
              title={
                recoveredWeb.pendingState === "matched"
                  ? "查看已保存的网页"
                  : "继续处理网页输入"
              }
              soft
              onPress={() => {
                const found =
                  recoveredWeb.pendingState === "matched"
                    ? readingSource(workspace, recoveredWeb.pending!.id)
                    : null;
                if (found) {
                  captureDraft({ web: null });
                  setRecoveredWeb(null);
                  openSource(found);
                } else setImporting(true);
              }}
            />
          )}
          {orphanQuestions.length > 0 && (
            <Button
              title="查看资料已不可用的问题输入"
              soft
              onPress={() => setShowOrphanQuestions(true)}
            />
          )}
        </View>
      )}
      <View style={{ flex: 1, flexDirection: "row" }}>
        {sidebarVisible && !source && (
          <View style={s.sidebar}>
            <View style={{ marginBottom: 26 }}>
              <Brand />
            </View>
            {nav(true)}
            <View style={{ flex: 1 }} />
            <Text style={s.caption}>读一点，理解多一点。</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          {source ? (
            <>
              <View style={s.pageHeader}>
                {readingNativePdf ? (
                  <IconButton
                    label={pagesPanelOpen ? "收起页面列表" : "打开页面列表"}
                    icon={PanelLeft}
                    onPress={() => setPagesPanelOpen((value) => !value)}
                  />
                ) : canShowSidebar ? (
                  <IconButton
                    label={sidebarVisible ? "收起导航侧栏" : "展开导航侧栏"}
                    icon={PanelLeft}
                    onPress={() => setSidebarCollapsed((value) => !value)}
                  />
                ) : null}
                <IconButton
                  label={tab === "home" ? "返回学习概览" : "返回资料库"}
                  icon={ArrowLeft}
                  onPress={returnFromSource}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={s.docTitle}>
                    {source.title}
                  </Text>
                </View>
                {Platform.OS !== "web" && source.kind === "pdf" && !!source.storagePath && (
                  <View style={s.headerInkTools}>
                    <PdfInkToolbar tools={pdfInkTools} />
                  </View>
                )}
                <View style={{ flex: 1 }} />
                <IconButton
                  label="阅读时写笔记"
                  icon={BookOpen}
                  onPress={startNote}
                  disabled={!spaces.length}
                />
                <IconButton
                  label="打开 AI 问答"
                  icon={Sparkles}
                  onPress={revealAI}
                />
              </View>
              <ErrorBox text={error} />
              <View style={{ flex: 1, flexDirection: "row" }}>
                <SourceReader
                  source={source}
                  inkNamespace={inkNamespace}
                  tools={pdfInkTools}
                  pagesPanelOpen={pagesPanelOpen}
                  onTogglePagesPanel={() => setPagesPanelOpen(false)}
                  session={readerSession.current}
                  highlight={highlight}
                  highlightRequest={highlightRequest}
                  visible={!showAI || wide}
                  wide={wide}
                  onReadingMove={markReadingMove}
                  onOpenOriginal={
                    demo
                      ? undefined
                      : () => {
                          void Linking.openURL(
                            `${apiUrl}/#source/${encodeURIComponent(source.id)}`,
                          ).catch(() => setError("无法打开浏览器。"));
                        }
                  }
                />
                <View
                  style={[
                    {
                      flex: wide ? undefined : 1,
                      width: wide ? (width >= 1100 ? 350 : 320) : undefined,
                    },
                    !showAI && { display: "none" },
                  ]}
                >
                  {aiPanel}
                </View>
              </View>
            </>
          ) : note ? (
            <>
              <View style={s.pageHeader}>
                <IconButton
                  label={noteReturn.current ? "返回阅读" : "返回笔记"}
                  icon={ArrowLeft}
                  onPress={returnFromNote}
                />
                <Text style={s.docTitle}>笔记与知识</Text>
              </View>
              <ScrollView contentContainerStyle={s.reading}>
                {!!notice && (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={[s.caption, { color: "#287b69" }]}
                  >
                    {notice}
                  </Text>
                )}
                <Text style={s.eyebrow}>
                  {note.kind === "knowledge" ? "KNOWLEDGE" : "MY NOTES"}
                </Text>
                <Text style={s.title}>{note.title}</Text>
                <Text selectable style={s.readingText}>
                  {notePreview(note.content)}
                </Text>
                <Text style={s.caption}>
                  当前以正文阅读呈现，复杂排版与编辑请在网页版继续。
                </Text>
              </ScrollView>
            </>
          ) : (
            notebook
          )}
        </View>
      </View>
      {!wide && !source && !note && (
        <View accessibilityRole="tablist" style={s.bottomBar}>
          {nav()}
        </View>
      )}
      <Modal
        visible={confirmExit}
        accessibilityLabel="还有本次会话的问题输入"
        transparent
        animationType={reducedMotion ? "none" : "fade"}
        onRequestClose={() => setConfirmExit(false)}
      >
        <View style={s.modalBackdrop}>
          <View style={s.modalCard} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={s.section}>
              还有本次会话的问题输入
            </Text>
            <Text style={s.secondary}>
              有{" "}
              {recoverableQuestions(
                discussions.current,
                workspace,
                pendingQuestions.current,
              ).length + orphanQuestions.length}{" "}
              个未发送或未获得回答的问题只保留在当前会话。
              {demo
                ? "退出后，示例资料、本次编辑、问题和问答都会清除。"
                : "退出后，问题和本次问答会被清除；已确认保存到云端的资料与笔记不受影响。"}
            </Text>
            <Button
              title="继续学习，保留问题"
              onPress={() => setConfirmExit(false)}
            />
            <Button
              title={demo ? "退出示例并清除当前会话" : "退出并清除当前会话"}
              soft
              onPress={() => {
                setConfirmExit(false);
                onExit();
              }}
            />
          </View>
        </View>
      </Modal>
      {importing && snapshot && (
        <WebImportSheet
          snapshot={snapshot}
          owner={session?.id ?? null}
          api={api}
          demo={demo}
          initialSpace={filter === "all" ? "inbox" : filter}
          onSnapshot={(next) =>
            setSnapshot((previous) => adoptSnapshot(previous, next))
          }
          onBusyChange={(busy) => {
            saveBusy.current = busy;
            if (busy) {
              loadController.current?.abort();
              setLoading(false);
            }
          }}
          restored={recoveredWeb}
          onDraft={(value) => captureDraft({ web: value })}
          onAuthError={onAuthError}
          onClose={() => {
            captureDraft({ web: null });
            setRecoveredWeb(null);
            setImporting(false);
          }}
          onSaved={(created) => {
            captureDraft({ web: null });
            setRecoveredWeb(null);
            setImporting(false);
            setNotice(demo ? "示例资料已加入本次预览。" : "资料已保存到云端。");
            openSource(created);
          }}
          onOpenExisting={(existing) => {
            captureDraft({ web: null });
            setRecoveredWeb(null);
            setImporting(false);
            openSource(existing);
          }}
        />
      )}
      {pdfImporting && snapshot && (
        <PdfImportSheet
          visible={pdfImporting}
          spaces={spaces}
          initialSpace={filter === "all" || filter === "inbox" ? "" : filter}
          aiEnabled={workspace.aiEnabled}
          onImport={importPdfFile}
          onClose={() => setPdfImporting(false)}
        />
      )}
      <Modal
        visible={editor}
        accessibilityLabel="写下新的理解"
        transparent
        animationType={reducedMotion ? "none" : "fade"}
        onRequestClose={closeEditor}
      >
        <KeyboardAvoidingView
          style={[
            s.modalBackdrop,
            width < 600 && {
              padding: 0,
              paddingTop: Math.max(insets.top, 12),
              justifyContent: "flex-end",
            },
          ]}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View
            accessibilityViewIsModal
            style={[
              s.modalCard,
              width < 600 && {
                maxHeight: "96%",
                borderBottomLeftRadius: 0,
                borderBottomRightRadius: 0,
                padding: 18,
                paddingBottom: Math.max(16, insets.bottom),
                gap: 16,
              },
            ]}
          >
            <View style={s.spread}>
              <Text style={[s.section, { flex: 1 }]}>写下新的理解</Text>
              <IconButton label="关闭笔记编辑" icon={X} onPress={closeEditor} />
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ gap: 15, paddingBottom: 4 }}
              style={{ flexShrink: 1 }}
            >
              <Text style={s.label}>保存到知识库</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
              >
                {spaces.map((space) => (
                  <Pressable
                    key={space.id}
                    accessibilityRole="button"
                    accessibilityState={{
                      selected: noteSpace === space.id,
                      disabled: saving || !!pending.current,
                    }}
                    disabled={saving || !!pending.current}
                    onPress={() => {
                      setNoteSpace(space.id);
                      captureNote({ spaceId: space.id });
                    }}
                    style={[s.chip, noteSpace === space.id && s.selectedChip]}
                  >
                    <Text style={s.label}>{space.name}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <View style={{ gap: 8 }}>
                <Text style={s.label}>笔记标题</Text>
                <TextInput
                  accessibilityLabel="笔记标题"
                  placeholder="用一句话概括这个想法"
                  value={title}
                  onChangeText={(value) => {
                    setTitle(value);
                    captureNote({ title: value });
                  }}
                  editable={!saving && !pending.current}
                  maxLength={512}
                  style={s.input}
                />
              </View>
              <View style={{ gap: 8 }}>
                <Text style={s.label}>我的理解</Text>
                <TextInput
                  accessibilityLabel="笔记正文"
                  placeholder="用自己的话，记录一个想法…"
                  multiline
                  value={body}
                  onChangeText={(value) => {
                    setBody(value);
                    captureNote({ text: value });
                  }}
                  editable={!saving && !pending.current}
                  maxLength={50000}
                  style={[
                    s.input,
                    { minHeight: 160, textAlignVertical: "top" },
                  ]}
                />
              </View>
            </ScrollView>
            <View
              style={{
                gap: 10,
                paddingTop: 14,
                borderTopWidth: 1,
                borderTopColor: c.line,
              }}
            >
              <ErrorBox text={saveError} />
              <Text style={s.caption}>
                未保存输入仅保留在本次应用会话中。保存失败时，请先核对结果再重试。
              </Text>
              {pending.current ? (
                <Button
                  title={
                    saving
                      ? reconcilingNote
                        ? "正在核对…"
                        : "正在保存…"
                      : "重新连接，核对保存结果"
                  }
                  onPress={() => void reconcileNote()}
                  disabled={saving}
                />
              ) : (
                <Button
                  title={
                    saving
                      ? "正在保存…"
                      : demo
                        ? "保存在本次预览"
                        : "保存到云端"
                  }
                  icon={Check}
                  onPress={() => void saveNote()}
                  disabled={
                    saving || !title.trim() || !body.trim() || !noteSpace
                  }
                />
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <Modal
        visible={discard}
        accessibilityLabel="这篇笔记还没有确认保存"
        transparent
        animationType={reducedMotion ? "none" : "fade"}
        onRequestClose={() => setDiscard(false)}
      >
        <View style={s.modalBackdrop}>
          <View style={s.modalCard}>
            <Text style={s.section}>这篇笔记还没有确认保存</Text>
            <Text style={s.secondary}>
              返回继续编辑，或放弃当前页面的草稿。保存结果未知时，请先核对云端。
            </Text>
            <Button title="继续编辑" onPress={() => setDiscard(false)} />
            <Button
              title="放弃当前草稿"
              soft
              onPress={() => {
                setDiscard(false);
                setEditor(false);
                clearNoteDraft();
                setTitle("");
                setBody("");
              }}
            />
          </View>
        </View>
      </Modal>
      <Modal
        visible={showOrphanQuestions}
        accessibilityLabel="保留的问题输入"
        transparent
        animationType={reducedMotion ? "none" : "fade"}
        onRequestClose={() => setShowOrphanQuestions(false)}
      >
        <View style={s.modalBackdrop}>
          <View style={s.modalCard} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={s.section}>
              保留的问题输入
            </Text>
            <Text style={s.secondary}>
              原资料或知识库已不可用。这里只保留你输入的文字，不会自动改绑资料或发给
              AI。
            </Text>
            <ScrollView
              style={{ maxHeight: 350 }}
              contentContainerStyle={{ gap: 16 }}
            >
              {orphanQuestions.map((item) => (
                <View key={item.sourceId} style={{ gap: 6 }}>
                  <Text style={s.caption}>
                    {item.kind === "unanswered"
                      ? "未获得回答的问题"
                      : "未发送的问题"}
                  </Text>
                  <Text selectable style={s.body}>
                    {item.question}
                  </Text>
                </View>
              ))}
            </ScrollView>
            <Button
              title="保留并返回"
              onPress={() => setShowOrphanQuestions(false)}
            />
            <Button
              title="放弃这些问题输入"
              soft
              onPress={() => {
                orphanQuestionsRef.current = [];
                setOrphanQuestions([]);
                setShowOrphanQuestions(false);
                captureQuestions();
              }}
            />
          </View>
        </View>
      </Modal>
      <Modal
        visible={!!citation}
        accessibilityLabel="回到原文核对"
        transparent
        animationType={reducedMotion ? "none" : "fade"}
        onRequestClose={() => setCitation(null)}
      >
        <View style={s.modalBackdrop}>
          <View style={s.modalCard}>
            <View style={s.spread}>
              <Text style={s.section}>回到原文核对</Text>
              <IconButton
                label="关闭引用"
                icon={X}
                onPress={() => setCitation(null)}
              />
            </View>
            <Text style={s.label}>{citation?.title}</Text>
            <ScrollView>
              <Text selectable style={s.readingText}>
                {citation?.quote}
              </Text>
            </ScrollView>
            {citation &&
            readingSource(workspace, citation.sourceId, citation.versionId) &&
            readingBlocks(
              readingSource(workspace, citation.sourceId, citation.versionId)!,
            ).some((block) => block.chunkId === citation.chunkId) ? (
              <Button
                title="定位原文段落"
                onPress={() => {
                  const selected = citation;
                  answerRestore.capture();
                  setCitation(null);
                  setSourceId(selected.sourceId);
                  setShowAI(wide);
                  setHighlight(selected.chunkId);
                  setHighlightRequest((value) => value + 1);
                }}
              />
            ) : (
              <Text style={s.secondary}>
                来源版本已改变、不可用或无法精确定位，保留引用原文供核对。
              </Text>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}
