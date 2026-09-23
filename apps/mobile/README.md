# Conuo iPhone / iPad 客户端

同一个 React Native + Expo 工程，根据可用宽度切换手机单栏和 iPad 阅读／AI 并排。产品范围分别见 [iOS PRD](../../docs/IOS_PRD.md)、[iPadOS PRD](../../docs/IPADOS_PRD.md) 与 [iPadOS PDF 手写阅读专项 PRD](../../docs/IPADOS_HANDWRITING_PRD.md)。

## 当前已实现的代码

- 邮箱密码登录、Keychain 分块保存会话、前后台刷新、持久退出封锁与账号切换隔离。
- 读取同一云端工作区：学习概览、知识库、标题／标签筛选、已解析正文、笔记及知识页。
- 公开网页正文预览或仅收藏链接，可选择收件箱／知识库；重复链接先提示已有资料，独立另存需要明确确认。正文用于 AI 需单独授权，默认关闭。
- 针对一份固定版本资料提问，Markdown 回答、来源卡片及可精确匹配段落的引用定位。当前使用完整 JSON 回答，本次对话只保留在当前会话。
- 创建学习空间、新建纯文本笔记，沿用服务端工作区 revision CAS；失败保留当前草稿，结果未知时先核对云端，重试保持笔记身份，避免静默覆盖与重复创建。
- 正文段落目录、15–25 号字号、引用定位与本次会话阅读位置；返回资料或临时收起 AI 后可接续阅读，字号／布局变化按段落位置恢复。
- 手机单栏阅读；宽度至少 760px 时可并排阅读与 AI，低于 1100px 的阅读页收起主导航，至少 1100px 时可手动折叠侧栏。全局导航重置知识库筛选。
- 独立的示例预览：不会发起登录、模型请求或保存到云端。

这是原生客户端第一阶段，**不代表完整 iOS/iPadOS PRD 已交付**。当前没有原生文件导入、PDF 原件绘制、手写、系统分享扩展、多窗口、后台传输、离线资料库、云端对话历史写入和阅读进度回写。已有云端阅读进度用于续读入口展示，不能据此宣称原生阅读位置已同步。复杂编辑与原件阅读可在网页版继续。

## 本地启动

在仓库根目录执行：

```sh
npm install
npm run mobile:dev
```

配置 `apps/mobile/.env.local`（参考 `.env.example`），只放公开的 API 地址、Supabase URL 和 publishable key。模型密钥、服务端密钥不进入客户端。API 只接受 HTTPS 根地址；默认测试站，生产接入独立验收。

真实 iOS 客户端使用 `Authorization: Bearer` 和 `X-Conuo-User`，无需浏览器 Cookie。**后端必须先部署本轮原生 Bearer 适配**，现有 staging 不会因本地代码变更自动支持该接口。此轮没有部署、创建账号或登录真实用户进行云端联调。

在支持相应 SDK 的开发设备上运行 Expo；签名安装包需在 macOS/Xcode 环境构建并完成 Apple 账号配置。当前 Windows 上的 `export:ios` 只验证 JS/Hermes bundle 构建，不会生成 IPA，也不能替代真机验收。没有自动开通 EAS、Apple 付费资源或发布到商店。

```sh
npm run ios --workspace @conuo/mobile
npm run export:ios --workspace @conuo/mobile
npm run typecheck --workspace @conuo/mobile
npm run test --workspace @conuo/mobile
```

## 界面预览

```sh
npm run mobile:preview
```

浏览器端只提供标记清楚的示例工作区，用于检查布局和交互。这里没有真实登录，不开放跨站 Cookie/CORS，也不等同于新增另一套生产 Web 产品。

本机当前保留静态示例预览：<http://127.0.0.1:8082>。示例网页提取显示内置演示正文，不访问输入的网址。

- 一致性保障：正文位置按段落锚点续读；回答、草稿、列表位置与账号走既有恢复门禁；会话输入、未发送问题与未保存笔记仅存本次进程，云端确认前不宣称已保存。
- 独立新增（2026-09-22，本地）：阅读位置按语义锚点节流回写云端 `readPage/lastReadAt`（15 秒合并、离开阅读器与进入后台前刷新、409 读回核对）；每次回答完成即作为该资料文档对话追加保存到云端 `conversations`（沿用 Web 合同，按 requestId 幂等，上限 20 轮），AI 面板可核对云端历史；结构变更经移动与 Web 测试验证无回归。

## 本轮增量验证（2026-09-21）

- 移动核心测试 37/37、Web 网页导入合同测试 5/5 通过；移动／Web 类型检查与定向 Web ESLint 通过。
- iOS Hermes 与 Web 导出通过；没有生成 IPA，也没有进行原生真机或真实云端联调。
- 浏览器实测 390×844 的阅读、问答、引用和目录，834×1194 的双栏、1194×834 的三栏，以及 320×700 的链接收藏、重复提醒、草稿保护与打开已有资料。
- 本轮仅本地完成，未新建账号、请求真实模型、提交、推送或部署。浏览器验证不能替代安全区、软件键盘、Keychain 和系统分屏的真机验收。

## 数据边界

当前已经实现的资料与文字草稿只保留在当前进程内存，云端确认后才显示保存成功；应用被系统结束、退出或显式放弃草稿后不承诺恢复。未来 iPad 原始手写将按专项 PRD 增加账号隔离的未同步笔迹恢复箱；该能力尚未实现，不能由当前客户端状态推断。Keychain 只保存认证会话及退出封锁标记。即使 Keychain 保留了旧凭据，持久封锁也会阻止自动回到旧账号；只有重新登录且服务端验证该身份后才解封。

新建笔记与网页资料以完整云端快照为基线，保留客户端未编辑的字段。发生 409 不自动覆盖另一设备；请求响应未知时先按固定笔记 ID 或资料／版本身份核对终态，再由用户明确重试。网页提取不自动授权 AI；仅收藏链接不建立正文索引，不能用于资料问答。不对 Web 旧本地副本做读取或迁移。

## 技术依据

依赖按 [Expo SDK 版本配套表](https://docs.expo.dev/versions/latest/)及 `expo install --check` 核对。会话安全存储遵循 [SecureStore 文档](https://docs.expo.dev/versions/latest/sdk/securestore/)，前后台认证刷新参考 [Supabase 原生客户端指南](https://supabase.com/docs/guides/auth/quickstarts/react-native)。多包工程沿用 [Expo monorepo 支持](https://docs.expo.dev/guides/monorepos/)，Web 的 React 和 TypeScript 版本保持原有配置。
