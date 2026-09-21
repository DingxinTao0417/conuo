<p align="center"><img src="assets/conuo-logo.png" width="120" height="120" alt="Conuo Logo" /></p>
<h1 align="center">Conuo</h1>
<p align="center"><strong>陪你把知识学会。</strong></p>
<p align="center">以个人资料库为基础的 AI 陪伴学习工作台</p>
<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

Conuo 将文件、网页和笔记组织成可检索、可追溯的个人知识库。阅读时提问，回到原文核对依据，保存自己的理解，下次从上次的问题继续。

**收集资料 → 阅读提问 → 核对原文 → 保存理解 → 继续学习**

## 当前状态

Web 已部署独立 [staging](https://conuo-staging.vercel.app)，仍在完成生产发布验收。主自然 Cron 已通过；项目负责人已确认物理双设备同步与同浏览器真实找回密码通过。清理韧性、跨浏览器邮件与灾备等剩余门槛见[部署记录](docs/STAGING_DEPLOYMENT.md)和[生产发布手册](docs/PRODUCTION_RELEASE.md)。原生产尚未升级。

Windows/macOS 与 iOS/iPadOS 已进入本地设计开发，**尚未签名、发布或完成 Apple 真机验收**。本轮移动 Bearer API 改动尚未部署，不能将现有 staging 视为原生整链路已就绪。Expo Web 预览只展示明确标注的示例，不提供真实登录，也不替代原生验收。

| 平台            | 路线与当前范围                                                                           | 后续边界                                                      |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Web             | Next.js + React；现有云端学习工作台持续完善                                              | 正式发布按独立云端门槛推进                                    |
| Windows / macOS | Electron D0 安全宿主起步，D1 复用并验收完整 Web 云端功能                                 | D2 才实现本地数据库、文件缓存与离线共存；D3 系统浏览及分发    |
| iOS             | Expo SDK 57 + React Native 0.86；开发登录、云端资料/知识阅读、单资料 JSON 问答与文本笔记 | 当前只是 I1 部分起步；系统分享、完整阅读与发布按平台 PRD 验收 |
| iPadOS          | 与 iOS 共用工程，采用平板自适应布局                                                      | P1 云端宽屏核心；P2 才进入 Pencil、多窗口、分享与深度阅读增强 |
| Android         | 长期目标                                                                                 | 不在本轮原生开发范围                                          |

Web 和首批客户端以云端作为正式资料存储。浏览器业务输入与原件仅在会话内存暂存；原生安全认证存储不等于本地资料库。桌面 D2 才提供本地与云端共存，当前没有完整离线工作区。详见 [Web 存储政策](docs/WEB_CLOUD_STORAGE.md)及各平台 PRD。

## Web 功能概览

| 能力         | 现有功能                                                                          |
| ------------ | --------------------------------------------------------------------------------- |
| 资料与知识库 | 学习空间、资料书架、标签、筛选、普通搜索与回收站；资料和 AI 知识页分别管理        |
| 文件与网页   | PDF、DOCX、Markdown、TXT、公开网页导入；保留原件与版本；支持备份恢复和导出        |
| 阅读         | PDF 单页/连续滚动、正文阅读、批注、引用回跳与云端阅读位置                         |
| 基于资料问答 | 当前资料或明确选择范围提问；回答支持 Markdown、公式与原文引用；AI 使用须先授权    |
| 区域视觉学习 | 明确发送 PDF 当前区域截图后解读、提问或生成一次性练习；不依赖 OCR，不创建全文索引 |
| 知识整理     | 摘要、标签、主题草稿、知识页更新与关系建议；人工审核后保存，保留来源和历史        |
| 笔记与接续   | 富文本笔记、摘录、对话记录、继续学习和未解决问题                                  |
| 账号与保存   | Supabase Auth、私有 Storage、云端版本冲突保护、资料删除与账号注销流程             |

“已保存”以云端确认结果为准；断网不创建匿名或本地工作区。AI 生成内容不自动替代原始资料。原生客户端实际覆盖范围单独记录，不由此表推断。

## 快速开始

需要 **Node.js 24+** 和 npm。在仓库根目录执行：

```bash
npm install
npm run dev
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。按[云端配置](docs/CLOUD_SETUP.md)填写 [Web 环境示例](apps/web/.env.example)，配置后登录使用；未配置或未登录时不会创建匿名工作区。PDF worker 与 Logo 由开发/构建脚本准备。

公开配置只能包含项目 URL 与 publishable/anon key。模型密钥和 Supabase 特权密钥只放服务端，不打包到客户端、不提交到 Git。模型接入见[模型配置](docs/MODEL_SETUP.md)。

## 开发命令

| 命令                                                 | 用途                           |
| ---------------------------------------------------- | ------------------------------ |
| `npm run dev`                                        | Web 开发服务器                 |
| `npm run build` / `npm start`                        | 构建 / 运行 Web 生产构建       |
| `npm run typecheck` / `npm run lint` / `npm test`    | Web 类型、静态与测试检查       |
| `npm run desktop:dev`                                | 启动 Electron 开发宿主         |
| `npm run desktop:build`                              | 桌面本地构建；不等于签名或发布 |
| `npm run mobile:dev`                                 | Expo 原生开发入口              |
| `npm run mobile:preview`                             | 移动/平板 Web 示例预览         |
| `npm run clients:typecheck` / `npm run clients:test` | 客户端类型与测试检查           |

测试结果与平台构建限制见[客户端开发记录](docs/CLIENT_IMPLEMENTATION.md)，Web 云端验收证据见[开发状态](docs/IMPLEMENTATION_STATUS.md)。迁移测试使用 PGlite，不需要安装或启动本地 PostgreSQL。Apple 原生系统构建与真机验收需对应环境，浏览器预览无法替代。

## 技术与目录

Web 和统一业务 API 使用 Next.js、React、TypeScript、Tailwind CSS；PDF.js 和 Tiptap 负责现有阅读与编辑。Supabase 提供 Auth、PostgreSQL、私有 Storage 与 pgvector，Vercel 承载 Web/API。Python 有界索引 CLI 与云端任务调度有各自部署边界，详见[技术方案](docs/TECH_STACK.md)。

```text
conuo/
├── apps/web/          # Web、统一业务 API 与测试
├── apps/desktop/      # Electron 桌面宿主
├── apps/mobile/       # Expo iOS / iPadOS 同工程双布局
├── apps/processor/    # Python 有界索引 CLI
├── supabase/          # 数据库迁移与隔离验证
├── docs/              # 公共/平台 PRD、功能说明与发布证据
├── assets/            # 品牌资源
├── README.md          # 默认中文入口
└── README.en.md       # English
```

本地 `conuo-design/` 设计资产保留并由 Git 忽略，不是运行时依赖。旧页面生成提示词已退出当前文档体系，设计依据改为公共/平台 PRD 与[界面规范](docs/UI_STYLE_GUIDE.md)。

## 文档

- 产品：[公共 PRD](docs/PRD.md) · [Windows/macOS](docs/DESKTOP_PRD.md) · [iOS](docs/IOS_PRD.md) · [iPadOS](docs/IPADOS_PRD.md)
- 开发：[技术方案](docs/TECH_STACK.md) · [界面规范](docs/UI_STYLE_GUIDE.md) · [开发状态](docs/IMPLEMENTATION_STATUS.md)
- 云端：[配置](docs/CLOUD_SETUP.md) · [验收](docs/CLOUD_E2E_ACCEPTANCE.md) · [部署](docs/STAGING_DEPLOYMENT.md) · [生产发布](docs/PRODUCTION_RELEASE.md) · [灾备](docs/DISASTER_RECOVERY.md)
- 功能：[文件版本](docs/FILE_VERSIONS.md) · [区域视觉](docs/REGION_STUDY.md) · [流式问答](docs/STREAMING_ANSWERS.md) · [搜索](docs/SEARCH_INDEXING.md) · [知识整理](docs/ORGANIZATION.md) · [备份恢复](docs/BACKUP_RESTORE.md) · [导出](docs/EXPORT_FORMAT.md)

需求、代码、本地验证、真实云端/真机验收、签名和发布分别记录。详细产品文档当前以简体中文维护。

## 许可证

项目尚未选定许可证，当前没有 `LICENSE` 文件。第三方组件与资源遵循各自授权。
