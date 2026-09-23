# Conuo iPadOS P2 前期选型与接口设计

| 属性         | 内容                                                        |
| ------------ | ----------------------------------------------------------- |
| 版本 / 日期  | v0.1 / 2026-09-22                                          |
| 平台         | iPadOS（Expo SDK 57 + React Native 0.86 共用工程）         |
| 状态         | **选型与接口草案，未实现、未真机验收**                     |
| 对应需求     | [iPadOS PRD](IPADOS_PRD.md) 第 6—10 节（P-RDR/P-INK/P-AI） |
| 约束         | 云端为正式存储；原生 PDF / Pencil / 多窗口未经真机验收前一律标注未完成 |

本文只记录 P2 起步的选型证据与接口草案，**不构成功能已交付**。任何渲染方案、笔迹模型或服务端接口都必须先通过下一轮 POC 与真机矩阵，才能进入实现。

## 1. 边界

- 移动端当前阅读正文为已解析文本（段落块），不含 PDF 原件绘制、批次笔迹或截图发送。
- Web 端区域视觉已有 `POST /api/v1/vision/region-study` 合同，原生端同一服务端链路，但选区坐标与截图来源需按物理页归一化矩形重新约定。
- 笔迹本身应可靠保存；识别只是后续可选能力，不能因识别失败丢失笔画。

## 2. 原生 PDF 阅读器选型

### 2.1 候选方案

| 方案 | 本质 | 中文/旋转/裁剪/扫描件 | 文字层 | 批注 | 维护与合规 | Expo 集成 |
| ---- | ---- | --------------------- | ------ | ---- | ---------- | --------- |
| A. react-native-pdf 7.x（wonday） | iOS 底层 PDFKit / Android PdfRenderer 的渲染视图 | 随系统渲染；旋转页与裁剪框表现需实测样本 | 无检索 API，仅渲染 | 无；需上层自绘叠加 | 开源、慢发布周期 | dev build + config plugin，**不能用 Expo Go** |
| B. react-native-pdf-jsi（新） | JSI 加速渲染，含搜索/高亮/导出 | 声称全面，样本未实测 | 有 `searchTextDirect` 与高亮矩形 | 书签/高亮有限 | 新生态、维护证据少 | dev build + plugin |
| C. PDF.js 封装进 RN（WebView / react-pdf） | 浏览器渲染器 | 中文良好、旋转裁剪可配置 | 完整文本层/检索/选区 | 可选用 PDF.js annotation 或自绘 | 大而全，WebView 与原生交互有异步边界 | 易进，但性能与 Pencil 延迟风险高 |
| D. 自建 Expo 本地模块 + Apple PDFKit | 原生 PDFKit 直接暴露给 JS | 系统级最稳，可实测 | PDFKit 原生有字符级坐标/检索（`characterIndex(at:)`） | PDFKit 原生 annotation 与渲染层同一坐标系，Pencil 集成潜力最大 | 需 Xcode 构建与本地模块维护 | 需要本地模块工程 |
| E. Nutrient（商用 SDK） | 全功能商业 SDK | 成熟 | 完整 | 完整（含表单/签名） | 付费、闭源、体积大 | 支持 |

### 2.2 判定维度与初步倾向

关键需求不是"显示 PDF"，而是：

1. **语义锚定**：批注/引用必须绑定"物理页 + 版本 + 坐标"，方案 C/D 较易拿到精确页码与文字坐标；A/B 的页码可达，文字坐标受限于库 API。
2. **Pencil 叠加**：笔画需在同一坐标系覆盖页渲染。A/B/C 都需要 RN 层叠加 Ink 视图并手写采集轨迹；D 可在原生层直接合成，延迟最小。
3. **区域 AI**：框选后需要按归一化矩形截取当前页渲染图。所有方案都需"页面渲染为位图"能力（A/B 已具备；C 通过 canvas；D 通过 PDFKit）。

**初步结论**：以 **方案 A（react-native-pdf）作为首期渲染底座 + RN 叠加笔迹层** 推进 POC，同时并行评估 **方案 D（PDFKit 本地模块）** 用于文字层检索与批注锚定。不选择 E（付费闭源）除非 POC 证明自研成本失控；不选择 C 作为主渲染（交互延迟与内存风险）。

### 2.3 POC 清单（下一轮，未执行）

- [ ] 用自编样本验证：中文 PDF、旋转 90° 页、异形裁剪框、含文字层 PDF、纯扫描 PDF（无文字层）在 A 与 D 下的渲染与翻页。
- [ ] 页坐标到 PDF 点坐标的换算（缩放/边距/PDFView 内边距）在两种断点（760、1100+）下的稳定性。
- [ ] 每页渲染位图导出与内存占用（30 MiB / 200 页级别文件）。
- [ ] Pencil 延迟与绘制帧率（真机）。
- [ ] Expo dev build / Xcode 可构建、可接入现有深链接与 workspace revision。

## 3. Pencil 笔迹模型与存储接口草案

### 3.1 数据模型

笔迹是二进制时序轨迹，**不进入 workspace JSONB 快照**（与 Web 3 MiB 上限解耦）。

```ts
type InkStroke = {
  id: string;
  points: { x: number; y: number; t: number; p?: number }[];
  // PDF 点坐标（页面归一化坐标系）；t 为笔迹内毫秒偏移，p 为可选的压感 0..1
  tool: "pen" | "highlighter";
  width: number;      // 逻辑宽度（PDF 点）
  color: string;      // 十六进制
};

type InkBatch = {
  id: string;                 // 每批笔画的稳定身份（UUID）
  sourceId: string;
  versionId: string;          // 固定资料版本；换版不得把旧笔画悄悄挂到新页
  page: number;               // 物理页（1-based）
  coordinateSystem: "pdf-points-v1";
  strokes: InkStroke[];
  status: "local" | "uploading" | "cloud" | "failed";
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;         // 软删，供多设备冲突判定
};
```

- `P-INK-02/03/07`：身份 = `sourceId + versionId + page + batchId`；缩放/旋转后位置保持一致依赖"PDF 点坐标 + 页面变换重算"，不保存位图预览为唯一形态。
- `P-INK-10`：并发新增按 batchId 合并；同一 batch 删除/变更冲突保留可判断结果，旧批次不复活。

### 3.2 本机保存状态机（P-INK-07/09/11）

```text
采集 (内存) ──-> 本机已保护（沙盒原子文件 + 提交清单）
      │                │ 重试/恢复
      v                v
   upload ───-> 云端已确认（服务端对象与元数据确认）
      │失败
      v
  saved-failed（保留本机受保护副本，提示"本机已保护 / 云端未确认"）
```

- 恢复箱为账号隔离目录（`expo-file-system` 应用沙盒），只保存未同步笔迹与提交清单，**不构成完整离线资料库**。
- 进入后台前尽力写原子快照；云端上传只能尽力，不承诺后台持续。

### 3.3 云端接口草案（待迁移与权限验证）

- `PUT /api/v1/sources/:sourceId/ink/:batchId`（Bearer + `X-Conuo-User`；幂等键 = batchId；资料版本/删除/权限变化时拒绝）
- `GET /api/v1/sources/:sourceId/ink?page=&versionId=`（取某页批）
- 存储：Supabase 私有 Storage 桶（每账号目录，对象路径含 source/version/page/batch）+ PostgreSQL 元数据表 `source_ink_batches`（身份、坐标版本、提交状态、租约）
- 迁移草案：`supabase/migrations/20260923000100_source_ink_batches.sql`（表 + RLS + 页级版本核验 + 发布复核 RPC），仅在独立 staging 应用并核验后再谈生产。
- 容量与清理：对象生命周期与 source purge / account deletion 复用既有 outbox 链路；历史版本独立归档。

## 4. 区域 AI 方案

- 框选绑定物理页 + 归一化矩形（`{page, x, y, w, h}`，均为 PDF 点或 0..1 归一化，避免分栏偏移），确认后按当前版本与新矩形截图。
- 复用 Web `POST /api/v1/vision/region-study` 合同；请求体增加 `coordinateSystem` 与 `page/rect`，结果沿用统一可复制 Markdown（摘要/观察/学习要点）。
- 边界：默认只含授权原文区域；有用户笔迹时**明确选择是否一并发送**；后台中断后查询云端状态，不自动重发收费请求。
- 截图来源依赖 2.2 的"页渲染为位图"；扫描件无文字层时区域学习仍可发起。

## 5. 风险评估

| 风险 | 影响 | 预案 |
| ---- | ---- | ---- |
| react-native-pdf 对旋转页/裁剪框/文字层细节不达标 | 阅读体验与锚定错误 | POC 样本矩阵先行；不达标切方案 D |
| Ink 叠加层与手势（双指缩放/单指滚动/Pencil）冲突 | 误触污染正文 | 独立标注模式（P-RDR-04）；手掌误触控制 |
| 3 MiB 快照与笔迹二进制混存导致容量爆炸 | 保存失败 | 笔迹独立存储，不进 JSONB |
| 上传失败恢复箱没有生命周期 | 空间膨胀/隐私 | 账号隔离 + 提交清单 + 明确清理语义 |
| Expo dev build / Xcode 构建门槛 | 无法真机验证 | POC 先验证 build；不替代真机 |
| 商业闭源方案（E）引入成本 | 依赖与授权风险 | 保持自研选项 A/D |

## 6. 真机验收清单（未执行，进入 P2 实现后逐项核证）

- [ ] 常用 iPad 尺寸 + 窄分屏下渲染/笔迹帧率与延迟
- [ ] 中文、旋转页、不同裁剪框、文字层、扫描件样本
- [ ] Pencil 书写/缩放/旋转/撤销/重开（记录设备、系统、Pencil 型号）
- [ ] 手指翻页与手掌误触（手势模式可理解）
- [ ] 双窗口编辑同一笔迹/笔记冲突（P-SYS-02/03）
- [ ] 区域 AI 预览与实际发送选区一致，无邻页/旁栏内容
- [ ] VoiceOver、动态字体、减弱动态效果

## 7. 参考

- [iPadOS 手写阅读专项 PRD](IPADOS_HANDWRITING_PRD.md)
- 方案 A: https://www.npmjs.com/package/react-native-pdf · 方案 B: https://www.npmjs.com/package/react-native-pdf-jsi
- Expo config plugin 与 Expo Go 限制说明（上述 npm 文档）