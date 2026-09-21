import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "./useReducedMotion";
import { Globe, Link2, X } from "lucide-react-native";
import * as Crypto from "expo-crypto";
import { type createApi } from "../core/api";
import {
  authInterruptionReason,
  webSaveReceipt,
  type RestoredDrafts,
  type WebDraftInput,
  type WebReceipt,
} from "../core/draft-recovery";
import { blankWorkspace, type Snapshot, type Source } from "../core/contracts";
import {
  createWebSource,
  duplicateWebSource,
  normalizeImportUrl,
  type WebPreview,
} from "../core/web-import";
import { colors as c, styles as s } from "../theme";

type Props = {
  snapshot: Snapshot;
  owner: string | null;
  api: ReturnType<typeof createApi> | null;
  demo: boolean;
  initialSpace: string;
  onSnapshot: (value: Snapshot) => void;
  onSaved: (source: Source) => void;
  onOpenExisting: (source: Source) => void;
  onBusyChange: (busy: boolean) => void;
  onAuthError: (cause: unknown) => void;
  restored?: RestoredDrafts["web"];
  onDraft: (value: WebDraftInput | null) => void;
  onClose: () => void;
};

function Action({
  title,
  onPress,
  soft = false,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  soft?: boolean;
  disabled?: boolean;
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
        pressed && { opacity: 0.75 },
        focused && { outlineColor: c.brand, outlineWidth: 2, outlineOffset: 2 },
      ]}
    >
      <Text style={[s.buttonText, soft && { color: c.ink }]}>{title}</Text>
    </Pressable>
  );
}

export default function WebImportSheet(props: Props) {
  const { width } = useWindowDimensions();
  const narrow = width < 600;
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [url, setUrl] = useState(props.restored?.url ?? ""),
    [title, setTitle] = useState(props.restored?.title ?? "");
  const [spaceId, setSpaceId] = useState(
    props.restored?.spaceId ?? props.initialSpace,
  );
  const inputs = useRef({
    url: props.restored?.url ?? "",
    title: props.restored?.title ?? "",
    titleEditedByUser: props.restored?.titleEditedByUser ?? false,
    spaceId: props.restored?.spaceId ?? props.initialSpace,
  });
  const [preview, setPreview] = useState<WebPreview | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(
      props.restored
        ? "已恢复你输入的链接和标题。正文预览与 AI 授权需要重新确认。"
        : "",
    );
  const [previewing, setPreviewing] = useState(false),
    [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [allowDuplicate, setAllowDuplicate] = useState(false),
    [aiAllowed, setAiAllowed] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false),
    [unconfirmed, setUnconfirmed] = useState(!!props.restored?.pending);
  const [canRepreview, setCanRepreview] = useState(
    props.restored?.pendingState === "missing",
  );
  const [pendingSource, setPendingSource] = useState<Source | null>(null);
  const alive = useRef(true),
    controller = useRef<AbortController | null>(null),
    busy = useRef(false);
  const identity = useRef(
    props.restored?.identity ?? {
      id: Crypto.randomUUID(),
      versionId: Crypto.randomUUID(),
      now: new Date().toISOString(),
    },
  );
  const pending = useRef<WebReceipt | null>(props.restored?.pending ?? null);
  const previousPending = useRef<WebReceipt[]>(
    props.restored?.previousPending ?? [],
  );
  function captureInput(patch: Partial<typeof inputs.current> = {}) {
    inputs.current = { ...inputs.current, ...patch };
    props.onDraft({
      ...inputs.current,
      identity: identity.current,
      pending: pending.current ?? undefined,
      previousPending: previousPending.current,
    });
  }
  const data = props.snapshot.data ?? blankWorkspace();
  useEffect(() => {
    if (!data.aiEnabled) setAiAllowed(false);
  }, [data.aiEnabled]);
  const spaces = data?.spaces.filter((space) => !space.archived) ?? [];
  let duplicate: Source | undefined;
  try {
    if (data && url.trim())
      duplicate = duplicateWebSource(data, url, preview ?? undefined);
  } catch {
    /* Input can be incomplete. */
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  function fail(cause: unknown) {
    if (!alive.current) return;
    setError(
      cause instanceof Error ? cause.message : "暂时无法完成，请稍后重试。",
    );
    if (authInterruptionReason(cause)) props.onAuthError(cause);
  }
  function close() {
    if (busy.current) return;
    if (url.trim() || title.trim() || pending.current) setConfirmClose(true);
    else props.onClose();
  }
  async function getPreview() {
    if (busy.current || unconfirmed) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setPreviewing(true);
    setError("");
    setNotice("");
    setPreview(null);
    setAiAllowed(false);
    try {
      const normalized = normalizeImportUrl(url);
      const result: WebPreview = props.demo
        ? {
            originalUrl: normalized,
            finalUrl: normalized,
            capturedAt: new Date().toISOString(),
            title: "一次阅读，留下一点理解",
            kind: "article",
            siteName: "Conuo 示例",
            excerpt: "读完一段，试着用自己的话解释。",
            warnings: ["示例内容：未访问或提取输入的网址。"],
            text: "读完一段，试着用自己的话解释。\n\n一个有用的学习习惯，是把阅读变成与资料的对话：先写下问题，再寻找依据。\n\n每次只留下一点新的理解。用自己的例子检验它，并把仍然不确定的地方记下来。",
          }
        : await props.api!.previewWeb(props.owner!, normalized, abort.signal);
      if (!alive.current || abort.signal.aborted) return;
      setPreview(result);
      if (!inputs.current.titleEditedByUser) {
        setTitle(result.title);
        captureInput({ title: "", titleEditedByUser: false });
      }
    } catch (cause) {
      if (!abort.signal.aborted) fail(cause);
    } finally {
      if (alive.current && controller.current === abort) setPreviewing(false);
    }
  }
  function changeUrl(value: string) {
    controller.current?.abort();
    setPreviewing(false);
    setUrl(value);
    setPreview(null);
    setTitle("");
    captureInput({ url: value, title: "", titleEditedByUser: false });
    setAiAllowed(false);
    setAllowDuplicate(false);
    setError("");
    setNotice("");
  }
  async function save(mode: "article" | "link") {
    if (busy.current || unconfirmed || !data) return;
    busy.current = true;
    props.onBusyChange(true);
    setSaving(true);
    setError("");
    setNotice("");
    controller.current?.abort();
    setPreviewing(false);
    try {
      if (pending.current && previousPending.current.length >= 10)
        throw new Error(
          "这次导入已有多次未确认提交，请先核对云端或明确放弃后再收集。",
        );
      // Keep the source identity across retries. A fresh extraction gets a new version;
      // old receipts remain available if an earlier, unknown request arrives late.
      const candidateIdentity = pending.current
        ? { ...identity.current, versionId: Crypto.randomUUID() }
        : identity.current;
      const next = createWebSource(data, {
        ...candidateIdentity,
        url,
        title: title.trim() || undefined,
        spaceId,
        preview: preview ?? undefined,
        mode,
        allowDuplicate,
        aiAllowed: mode === "article" && data.aiEnabled && aiAllowed,
      });
      const created = next.sources.find(
        (source) => source.id === identity.current.id,
      )!;
      const receipt = await webSaveReceipt(created, (value) =>
        Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
      );
      if (!alive.current) return;
      if (pending.current)
        previousPending.current = [...previousPending.current, pending.current];
      identity.current = candidateIdentity;
      pending.current = receipt;
      captureInput();
      setPendingSource(created);
      setUnconfirmed(true);
      setCanRepreview(false);
      const saved = props.demo
        ? { data: next, revision: props.snapshot.revision + 1 }
        : await props.api!.save(props.owner!, props.snapshot, next);
      if (!alive.current) return;
      pending.current = null;
      props.onDraft(null);
      setUnconfirmed(false);
      props.onSnapshot(saved);
      props.onSaved(created);
    } catch (cause) {
      fail(cause);
    } finally {
      busy.current = false;
      props.onBusyChange(false);
      if (alive.current) setSaving(false);
    }
  }
  async function reconcile() {
    if (busy.current || !pending.current || !props.api || !props.owner) return;
    busy.current = true;
    props.onBusyChange(true);
    setReconciling(true);
    setSaving(true);
    setError("");
    try {
      const latest = await props.api.load(props.owner);
      if (!alive.current) return;
      props.onSnapshot(latest);
      const expected = pending.current;
      const found = latest.data?.sources.find(
        (source) => source.id === expected?.id,
      );
      const actual =
        found && !found.deletedAt && found.kind === "web"
          ? await webSaveReceipt(found, (value) =>
              Crypto.digestStringAsync(
                Crypto.CryptoDigestAlgorithm.SHA256,
                value,
              ),
            )
          : null;
      if (!alive.current) return;
      if (
        found &&
        actual &&
        [expected, ...previousPending.current].some(
          (receipt) =>
            receipt.versionId === actual.versionId &&
            receipt.fingerprint === actual.fingerprint,
        )
      ) {
        pending.current = null;
        props.onDraft(null);
        setUnconfirmed(false);
        props.onSaved(found);
      } else if (found) {
        setCanRepreview(false);
        setPendingSource(found);
        setError(
          "云端已有这份资料，但内容或状态已改变。请先查看云端版本，当前输入不会自动覆盖它。",
        );
      } else {
        setPendingSource(null);
        setCanRepreview(true);
        setNotice(
          "已核对云端，未找到本次资料。请重新预览并确认内容后再保存；我们会继续核对这份资料，避免重复添加。",
        );
      }
    } catch (cause) {
      fail(cause);
    } finally {
      busy.current = false;
      props.onBusyChange(false);
      if (alive.current) {
        setSaving(false);
        setReconciling(false);
      }
    }
  }
  const frozen = saving || unconfirmed;
  return (
    <Modal
      visible
      accessibilityLabel="添加网页资料"
      transparent
      animationType={reducedMotion ? "none" : "fade"}
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        style={[
          s.modalBackdrop,
          narrow && {
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
            { maxWidth: 620 },
            narrow && {
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
            <View style={[s.row, { flex: 1, minWidth: 0 }]}>
              <View
                style={[
                  s.fileIcon,
                  { height: 40, width: 40, backgroundColor: c.blue },
                ]}
              >
                <Globe size={21} color="#396bb8" />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.section}>添加网页资料</Text>
                <Text style={s.caption}>保存公开网页，留待慢慢读。</Text>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭添加网页"
              onPress={close}
              disabled={saving}
              style={s.iconButton}
            >
              <X size={21} color={c.secondary} />
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 16, paddingBottom: 4 }}
            style={{ flexShrink: 1 }}
          >
            {confirmClose ? (
              <View style={{ gap: 14 }}>
                <Text style={s.section}>
                  {pending.current ? "这次保存还需要核对" : "保留这次输入吗？"}
                </Text>
                <Text style={s.secondary}>
                  {pending.current
                    ? "请求可能已保存到云端。建议先核对；关闭不会撤销已经提交的资料。"
                    : "关闭后将放弃本次未保存的链接和预览。"}
                </Text>
                <Action
                  title="继续处理"
                  onPress={() => setConfirmClose(false)}
                />
                <Action
                  title={
                    pending.current
                      ? "关闭，稍后在资料库核对"
                      : "放弃输入并关闭"
                  }
                  soft
                  onPress={props.onClose}
                />
              </View>
            ) : (
              <>
                {props.demo && (
                  <Text style={s.bannerText}>
                    示例模式：不访问输入的网址，不保存到云端。
                  </Text>
                )}
                <View style={{ gap: 8 }}>
                  <Text style={s.label}>网页地址</Text>
                  <TextInput
                    accessibilityLabel="网页地址"
                    placeholder="https://…"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    value={url}
                    onChangeText={changeUrl}
                    editable={!frozen}
                    maxLength={8192}
                    style={s.input}
                  />
                </View>
                <Action
                  title={previewing ? "正在提取正文…" : "预览网页正文"}
                  soft
                  disabled={!url.trim() || frozen || previewing}
                  onPress={() => void getPreview()}
                />
                {previewing && <ActivityIndicator color={c.brand} />}
                {preview && (
                  <View
                    style={[s.card, { padding: 16, backgroundColor: c.canvas }]}
                  >
                    <View style={s.row}>
                      <Link2 size={16} color={c.brand} />
                      <Text style={[s.label, { flex: 1 }]}>
                        {preview.kind === "article"
                          ? "正文预览"
                          : "仅链接 · 未提取到正文"}
                      </Text>
                    </View>
                    {preview.warnings.map((warning, index) => (
                      <Text
                        key={index}
                        style={[s.caption, { color: "#916023" }]}
                      >
                        {warning}
                      </Text>
                    ))}
                    <Text numberOfLines={8} style={s.body}>
                      {preview.text || "可以先收藏链接，之后在网页版补充内容。"}
                    </Text>
                    {!!preview.text && (
                      <Text style={s.caption}>
                        共 {preview.text.length.toLocaleString()} 字符 ·
                        保存完整提取结果
                      </Text>
                    )}
                  </View>
                )}
                <View style={{ gap: 8 }}>
                  <Text style={s.label}>
                    资料标题 <Text style={s.caption}>（可选）</Text>
                  </Text>
                  <TextInput
                    accessibilityLabel="网页资料标题"
                    placeholder="为这份资料起个名字"
                    value={title}
                    onChangeText={(value) => {
                      setTitle(value);
                      captureInput({ title: value, titleEditedByUser: true });
                    }}
                    editable={!frozen}
                    maxLength={512}
                    style={s.input}
                  />
                </View>
                <Text style={s.label}>保存位置</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {[{ id: "inbox", name: "收件箱" }, ...spaces].map((space) => (
                    <Pressable
                      key={space.id}
                      accessibilityRole="button"
                      accessibilityLabel={`保存到${space.name}`}
                      accessibilityState={{
                        selected: spaceId === space.id,
                        disabled: frozen,
                      }}
                      disabled={frozen}
                      onPress={() => {
                        setSpaceId(space.id);
                        captureInput({ spaceId: space.id });
                      }}
                      style={[s.chip, spaceId === space.id && s.selectedChip]}
                    >
                      <Text style={s.label}>{space.name}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
                {duplicate && (
                  <View
                    style={[s.card, { padding: 14, backgroundColor: c.peach }]}
                  >
                    <Text style={s.label}>
                      资料库已有相同链接：{duplicate.title}
                    </Text>
                    <Action
                      title="打开已有资料"
                      soft
                      disabled={frozen || !!pending.current}
                      onPress={() => props.onOpenExisting(duplicate!)}
                    />
                    <View style={s.spread}>
                      <Text style={[s.secondary, { flex: 1 }]}>
                        仍保存一个独立副本
                      </Text>
                      <Switch
                        accessibilityLabel="仍保存一个独立副本"
                        value={allowDuplicate}
                        disabled={frozen}
                        onValueChange={setAllowDuplicate}
                      />
                    </View>
                  </View>
                )}
                {preview?.kind === "article" && (
                  <View style={[s.card, { padding: 14 }]}>
                    <View style={s.spread}>
                      <Text style={[s.label, { flex: 1 }]}>
                        允许 AI 使用这份正文
                      </Text>
                      <Switch
                        accessibilityLabel="允许 AI 使用这份正文"
                        value={data.aiEnabled && aiAllowed}
                        disabled={frozen || !data?.aiEnabled}
                        onValueChange={setAiAllowed}
                      />
                    </View>
                    <Text style={s.caption}>
                      {data?.aiEnabled
                        ? "由你明确授权。提问时仅发送必要的资料片段。"
                        : "工作区 AI 尚未开启，可先保存，再在网页版设置。"}
                    </Text>
                  </View>
                )}
              </>
            )}
          </ScrollView>
          {!confirmClose && (
            <View
              style={{
                gap: 10,
                paddingTop: 14,
                borderTopWidth: 1,
                borderTopColor: c.line,
              }}
            >
              {!!error && (
                <View accessibilityRole="alert" style={s.error}>
                  <Text style={s.errorText}>{error}</Text>
                </View>
              )}
              {!!notice && (
                <Text style={[s.secondary, { color: "#287b69" }]}>
                  {notice}
                </Text>
              )}
              {unconfirmed ? (
                <>
                  <Action
                    title={
                      saving
                        ? reconciling
                          ? "正在核对…"
                          : "正在保存…"
                        : "核对云端保存结果"
                    }
                    onPress={() => void reconcile()}
                    disabled={saving}
                  />
                  {canRepreview && (
                    <Action
                      title="重新预览并确认内容"
                      soft
                      disabled={saving}
                      onPress={() => {
                        setUnconfirmed(false);
                        setPreview(null);
                        setAiAllowed(false);
                        setNotice(
                          "请重新预览，再确认标题和 AI 授权。再次保存会核对同一份资料，避免重复添加。",
                        );
                      }}
                    />
                  )}
                  {pendingSource && (
                    <Text selectable style={s.caption}>
                      {saving && !reconciling
                        ? props.demo
                          ? "正在保存到本次预览，请稍候。"
                          : "正在保存到云端，请稍候。"
                        : `保存结果待核对：${pendingSource.title}。核对前不会再次提交。`}
                    </Text>
                  )}
                </>
              ) : (
                <>
                  {pending.current && (
                    <Action
                      title="再次核对之前的保存"
                      soft
                      disabled={saving}
                      onPress={() => void reconcile()}
                    />
                  )}
                  {preview?.kind === "article" && (
                    <Action
                      title={
                        saving
                          ? "正在保存…"
                          : props.demo
                            ? "保存示例正文"
                            : "保存正文到资料库"
                      }
                      disabled={saving || (!!duplicate && !allowDuplicate)}
                      onPress={() => void save("article")}
                    />
                  )}
                  <Action
                    title={saving ? "正在保存…" : "仅收藏链接"}
                    soft
                    disabled={
                      !url.trim() || saving || (!!duplicate && !allowDuplicate)
                    }
                    onPress={() => void save("link")}
                  />
                  <Text style={s.caption}>
                    仅收藏链接不会建立正文索引，也不能用于资料问答。
                  </Text>
                </>
              )}
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
