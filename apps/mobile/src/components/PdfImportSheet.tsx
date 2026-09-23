import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { FileText, Upload, X } from "lucide-react-native";
import type { Source, Workspace } from "../core/contracts";
import { colors as c, styles as s } from "../theme";

type Space = Workspace["spaces"][number];
type ImportResult = { source: Source; duplicate: boolean };

export type PdfImportPhase = "reading" | "uploading" | "saving";

export default function PdfImportSheet({
  visible,
  spaces,
  initialSpace,
  aiEnabled,
  onImport,
  onClose,
}: {
  visible: boolean;
  spaces: Space[];
  initialSpace: string;
  aiEnabled: boolean;
  onImport: (
    asset: DocumentPicker.DocumentPickerAsset,
    spaceId: string,
    aiAllowed: boolean,
    onPhase: (phase: PdfImportPhase) => void,
  ) => Promise<ImportResult>;
  onClose: () => void;
}) {
  const [spaceId, setSpaceId] = useState(initialSpace);
  const [aiAllowed, setAiAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<PdfImportPhase>("reading");
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (!visible) return;
    setSpaceId(spaces.some((space) => space.id === initialSpace) ? initialSpace : "");
    setAiAllowed(false);
    setBusy(false);
    setFilename("");
    setError("");
    setSuccess("");
  }, [initialSpace, visible]);

  async function chooseAndImport() {
    if (busy) return;
    setError("");
    setSuccess("");
    const picked = await DocumentPicker.getDocumentAsync({
      type: "application/pdf",
      multiple: false,
      copyToCacheDirectory: true,
    }).catch(() => null);
    if (!picked) {
      setError("无法打开“文件”选择器，请重试。");
      return;
    }
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset) {
      setError("没有取得所选文件，请重新选择。");
      return;
    }
    setFilename(asset.name);
    setBusy(true);
    setPhase("reading");
    try {
      const result = await onImport(asset, spaceId, aiAllowed && aiEnabled, setPhase);
      setSuccess(
        result.duplicate
          ? `“${result.source.title}”已在资料库中，已复用原件并更新归属。`
          : `“${result.source.title}”的原件和资料记录已确认保存到云端。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "文件导入失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  const phaseLabel =
    phase === "reading"
      ? "正在读取 PDF 并提取页面文字…"
      : phase === "uploading"
        ? "正在上传原件到私有云端存储…"
        : "正在确认资料库保存…";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
      statusBarTranslucent
    >
      <View style={p.backdrop}>
        <View accessibilityViewIsModal style={p.sheet}>
          <View style={s.spread}>
            <View style={s.row}>
              <View style={p.icon}>
                <FileText size={20} color={c.brand} />
              </View>
              <View style={{ flex: 1 }}>
                <Text accessibilityRole="header" style={s.section}>
                  上传 PDF
                </Text>
                <Text style={s.caption}>从“文件”选择原件，保存到你的 Conuo 资料库</Text>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭上传窗口"
              disabled={busy}
              onPress={onClose}
              style={({ pressed }) => [s.iconButton, pressed && p.pressed]}
            >
              <X size={20} color={busy ? c.muted : c.ink} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={p.body} keyboardShouldPersistTaps="handled">
            <View style={s.card}>
              <Text style={s.label}>保存到</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: spaceId === "" }}
                  onPress={() => setSpaceId("")}
                  disabled={busy}
                  style={[s.chip, spaceId === "" && s.selectedChip]}
                >
                  <Text style={[s.label, spaceId === "" && { color: c.brand }]}>收件箱</Text>
                </Pressable>
                {spaces.map((space) => (
                  <Pressable
                    key={space.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: spaceId === space.id }}
                    onPress={() => setSpaceId(space.id)}
                    disabled={busy}
                    style={[s.chip, spaceId === space.id && s.selectedChip]}
                  >
                    <Text style={[s.label, spaceId === space.id && { color: c.brand }]}>
                      {space.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>

            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: aiAllowed && aiEnabled, disabled: !aiEnabled || busy }}
              onPress={() => setAiAllowed((value) => !value)}
              disabled={!aiEnabled || busy}
              style={[s.card, p.consent, (!aiEnabled || busy) && { opacity: 0.62 }]}
            >
              <View style={[p.checkbox, aiAllowed && aiEnabled && p.checkboxSelected]}>
                {aiAllowed && aiEnabled ? <Text style={p.check}>✓</Text> : null}
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={p.consentTitle}>允许 AI 使用这份资料</Text>
                <Text style={s.caption}>
                  默认关闭。开启后可用于带出处问答；原件仍按你的账号权限保存在私有云端。
                </Text>
                {!aiEnabled && <Text style={s.caption}>当前工作区的 AI 已关闭。</Text>}
              </View>
            </Pressable>

            <View style={p.info}>
              <Text style={s.secondary}>支持 PDF，单份不超过 30 MiB。扫描件会保留原件，但当前不会 OCR。</Text>
              <Text style={s.caption}>上传和资料库云端确认完成前，不会显示为已保存。</Text>
            </View>

            {busy && (
              <View accessibilityRole="progressbar" style={[s.card, s.row]}>
                <ActivityIndicator color={c.brand} />
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={p.progress}>{phaseLabel}</Text>
                  {!!filename && <Text numberOfLines={1} style={s.caption}>{filename}</Text>}
                </View>
              </View>
            )}
            {!!success && (
              <View accessibilityRole="alert" style={p.success}>
                <Text style={p.successText}>{success}</Text>
              </View>
            )}
            {!!error && (
              <View accessibilityRole="alert" style={p.error}>
                <Text style={p.errorText}>{error}</Text>
              </View>
            )}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="从文件选择 PDF 并上传"
              disabled={busy}
              onPress={() => void chooseAndImport()}
              style={({ pressed }) => [s.button, pressed && p.pressed, busy && { opacity: 0.58 }]}
            >
              {busy ? <ActivityIndicator color="white" /> : <Upload size={18} color="white" />}
              <Text style={s.buttonText}>{busy ? "正在导入…" : success ? "再上传一份" : "从文件选择 PDF"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onClose}
              style={({ pressed }) => [s.button, s.softButton, pressed && p.pressed]}
            >
              <Text style={[s.buttonText, { color: c.ink }]}>{success ? "返回资料库" : "稍后再说"}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const p = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    paddingTop: 40,
    backgroundColor: "rgba(22, 23, 34, 0.34)",
  },
  sheet: {
    width: "100%",
    maxWidth: 760,
    maxHeight: "94%",
    alignSelf: "center",
    backgroundColor: c.canvas,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    paddingBottom: 28,
    gap: 18,
  },
  body: { gap: 14, paddingBottom: 6 },
  icon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: c.purple,
    alignItems: "center",
    justifyContent: "center",
  },
  consent: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  checkbox: {
    width: 23,
    height: 23,
    borderWidth: 1.5,
    borderColor: c.muted,
    borderRadius: 6,
    marginTop: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxSelected: { backgroundColor: c.brand, borderColor: c.brand },
  check: { color: c.white, fontWeight: "700", fontSize: 15, lineHeight: 18 },
  consentTitle: { color: c.ink, fontWeight: "600", fontSize: 14 },
  info: { gap: 6, paddingHorizontal: 2 },
  progress: { color: c.ink, fontSize: 14, fontWeight: "600" },
  success: {
    backgroundColor: c.green,
    borderColor: "#c9e6d4",
    borderWidth: 1,
    borderRadius: 12,
    padding: 13,
  },
  successText: { color: "#286b50", fontSize: 14, lineHeight: 21 },
  error: {
    backgroundColor: "#fff1f1",
    borderColor: "#f0cbcf",
    borderWidth: 1,
    borderRadius: 12,
    padding: 13,
  },
  errorText: { color: c.danger, fontSize: 14, lineHeight: 21 },
  pressed: { opacity: 0.76 },
});
