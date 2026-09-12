<p align="center">
  <img src="assets/conuo-logo.png" width="120" height="120" alt="Conuo Logo：相伴的书页与字母 C" />
</p>

<h1 align="center">Conuo · 可诺</h1>

<p align="center"><strong>陪你把知识学会。</strong></p>

<p align="center">以个人资料库为基础的 AI 陪伴学习工作台</p>

<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

<p align="center">
  <a href="docs/PRD.md">产品需求</a> ·
  <a href="docs/TECH_STACK.md">技术方案</a> ·
  <a href="docs/TRAE_DESIGN_PROMPT.md">页面设计</a> ·
  <a href="assets/conuo-logo.png">Logo</a>
</p>

---

Conuo 将文件、网页和笔记组织为可检索、可追溯的个人知识库。阅读时向 AI 提问，回到原文核对依据，把自己的理解保存下来，下次从上次的问题继续。

> **项目状态：产品方案与页面设计阶段。** 当前仓库包含需求文档、技术方案、页面设计提示词与 Logo；设计资源与页面原型在本地维护，不纳入 Git。尚未建立 Next.js 应用工程，第一版只开发响应式 Web。

## 核心能力

以下为首版功能规划，尚未实现。

| 能力 | 预期体验 |
| --- | --- |
| 统一资料库 | 导入文本 PDF、DOCX、Markdown、TXT 和公开文章链接，用学习空间与标签组织资料。 |
| 阅读与提问 | 阅读、选段、高亮、批注，并围绕当前文档或选定资料与 AI 讨论。 |
| 可追溯的回答 | 从回答中的引用跳回原文页码或章节；依据不足时明确说明。 |
| AI 知识整理 | 自动生成摘要与归类建议，按选定资料生成知识页草稿；由用户审核、编辑和接受。 |
| 笔记与学习接续 | 保存摘录、自己的理解和待解决问题，从上次阅读位置继续。 |
| 云端保存与管理 | 保存资料与编辑记录，展示同步状态，支持冲突恢复、导出和回收站。 |

核心学习流程：

**收集资料 → 阅读提问 → 核对原文 → 保存理解 → 继续学习**

### 产品原则

- **依据可核对**：区分原始资料、用户笔记和 AI 生成内容。
- **整理可控制**：AI 提供建议，保留人工修改，支持撤回与版本恢复。
- **状态可理解**：文件已保存、解析完成、可用于 AI 和云端已同步分别呈现。
- **先完善 Web**：响应式设计覆盖电脑、手机与 iPad 浏览器；独立客户端在核心功能稳定后评估。

## 文档与设计

| 入口 | 内容 |
| --- | --- |
| [产品需求文档](docs/PRD.md) | 使用场景、功能规则、数据生命周期、验收标准与版本规划。 |
| [技术选型与架构](docs/TECH_STACK.md) | 技术路线、模块边界、后台处理、云端保存与验证任务。 |
| [TraeWork Design 提示词](docs/TRAE_DESIGN_PROMPT.md) | Web、iOS / Android 手机与 iPad 的页面、交互、组件和状态设计要求。 |
| [Logo](assets/conuo-logo.png) | Conuo 品牌图形，PNG 格式。 |

产品与技术文档基线为 **v0.5**，页面设计提示词为 **v1.0**。本地 `conuo-design/` 中的设计资源与页面原型持续完善中，该目录已由 `.gitignore` 排除。原型中的模拟交互不代表业务功能已经实现。

## 技术栈

| 层级 | 选型 |
| --- | --- |
| Web 界面 | React · Tailwind CSS · TypeScript |
| 应用框架与业务 API | Next.js · TypeScript · Node.js Route Handlers |
| 数据库与向量检索 | Supabase PostgreSQL · pgvector |
| Web 与业务 API 部署 | Vercel |
| 阅读与编辑方案 | PDF.js · Tiptap |
| 文档解析与异步处理方案 | Python · Celery；队列接入与部署方式待验证 |
| 设计系统 | TraeWork |

Supabase 的已确认范围是数据库；登录、对象存储、实时通知与模型供应商仍待选定。具体依赖版本和后台任务部署以[技术方案](docs/TECH_STACK.md)及后续验证结果为准。

## 目录结构

```text
conuo/
├── .gitignore                       # 忽略本地设计目录
├── README.md                        # 中文首页（默认）
├── README.en.md                     # English README
├── assets/
│   └── conuo-logo.png               # Logo 图形
└── docs/
    ├── PRD.md                       # 产品需求
    ├── TECH_STACK.md                # 技术方案
    └── TRAE_DESIGN_PROMPT.md         # 页面设计提示词
```

## 开始了解项目

1. 阅读 [PRD](docs/PRD.md)，了解首版范围与完整学习流程。
2. 阅读[技术方案](docs/TECH_STACK.md)，确认模块职责与待验证项。
3. 按[页面设计提示词](docs/TRAE_DESIGN_PROMPT.md)使用 TraeWork Design，结合现有主题、组件与品牌资产推进页面设计。

当前尚未建立 Next.js 应用工程、依赖清单与启动脚本。应用工程建立后，在此补充开发环境、配置方式、启动命令与验证步骤。

## 路线图

| 阶段 | 目标 | 当前状态 |
| --- | --- | --- |
| 方案与设计验证 | 完善需求、关键页面与组件，验证解析、引用定位、检索和保存恢复。 | 文档与基础设计资源已整理，页面设计进行中，技术验证待完成 |
| M0 · 首版 Web | 打通资料导入、阅读问答、知识整理、笔记与云端保存。 | 待开发 |
| M1 · Web 完善 | 按试用反馈完善体验，逐步验证 OCR、更多格式、后台整理和全库搜索。 | 规划中 |
| M2 · 学习增强 | 探索自我解释、练习、回顾及可选的联网补充。 | 规划中 |

手机、iPad、Windows 与 macOS 独立客户端在 Web 核心功能和交互基本稳定后单独评估，尚未排期；不以完成全部 M2 功能作为启动前提。手写、系统分享和完整离线资料包在相应平台阶段验证。

## 协作约定

- 功能调整先对应到 PRD 的需求与验收场景，再更新相关设计或技术方案。
- 设计使用统一的 TraeWork 组件与 Conuo 品牌资产，覆盖加载、空白、失败和恢复状态。
- 实现与验证记录区分已完成能力、设计建议和待决策事项。

## 许可证

项目尚未选定许可证，当前目录中没有 `LICENSE` 文件。设计系统与图标资源的使用范围以其原始授权为准。
