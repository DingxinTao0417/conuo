# AI 增强实施进度

决策以 [AI_ENHANCEMENT_PLAN.md](AI_ENHANCEMENT_PLAN.md) 第 0.7 节为准。执行模型更新本表，不改手册。人类改决策时改 0.7，并在下面“人工事项”写日期与原因。

| 项        | 值                                    |
| --------- | ------------------------------------- |
| 分支      | `feat/ai-enhancement`（本地，未推送） |
| 下一个 WP | WP-19                                 |
| 当前阶段  | 阶段 1 待评审；阶段 2 进行中          |
| 更新日期  | 2026-09-24                            |

## 工作包状态

状态取值：`未开始` / `进行中` / `完成` / `阻塞` / `待评审` / `本轮不做`。

| 顺序 | WP           | 状态     | 提交                                                  | 测试                                                                                                                                                                                             | 备注                                                                                                                           |
| ---- | ------------ | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1    | WP-01        | 完成     | `4507833`                                             | 255 个测试文件／4264 项通过；typecheck、lint 通过；本 WP 文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` 文件和 12 个未涉及文件阻断                                                 | 定向问题、摘要、选段、比较、跨语言和 10 资料整理回归通过                                                                       |
| 2    | WP-02        | 完成     | `7e06567`                                             | 258 个测试文件／4269 项通过；模型评测 1 个文件跳过；typecheck 通过；lint 0 错误、1 条既有警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` 文件和 12 个未涉及文件阻断 | 76 条自编用例、15 类覆盖；`grounding-v7` 总体和各类命中率 1.0；隔离违规 0；真实模型评测未运行                                  |
| 3    | WP-05        | 完成     | `046898e`                                             | 258 个测试文件／4272 项通过；typecheck 通过；lint 0 错误、1 条既有警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` 文件和未涉及文件阻断                              | revision-only 探针；版本稳定时复用快照，变化时完整重载；无功能开关                                                             |
| 4    | WP-06        | 完成     | `a2e8bd1`                                             | 260 个测试文件／4288 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` 文件和未涉及文件阻断                    | `RICH_ANSWERS` 默认关闭；安全 Markdown、公式与 KaTeX；`grounding-v8`；未运行真实模型评测                                       |
| 5    | WP-04        | 完成     | `d493348`、`0c1ffc1`                                  | 262 个测试文件／4301 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 36 个 `._*` AppleDouble 文件阻断              | AI 请求 trace、provider usage、流式最终 usage 帧；30 天清理与 service_role RPC；默认关闭                                       |
| 6    | WP-03        | 完成     | `3a81562`                                             | 265 个测试文件／4310 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有警告；新增文件定向 Prettier 通过；仓库级 format:check 被既有 36 个 `._*` AppleDouble 文件阻断                        | 回答反馈、显式内容附带、撤回和人工转评测流程；阶段 0 离线门槛通过                                                              |
| 7    | WP-07        | 完成     | `73d41a3`                                             | 266 个测试文件／4323 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 36 个 `._*` AppleDouble 文件阻断   | 四档模型配置、问答／整理／后台整理／区域视觉路由档位指纹隔离；真实模型与部署未验收                                             |
| 8    | WP-09        | 完成     | `2edfa43`                                             | 267 个测试文件／4328 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` AppleDouble 文件阻断         | 完整资料长上下文、静态前缀与服务端引用上限；未运行真实模型评测                                                                 |
| 9    | WP-10        | 完成     | `9cbbc69`                                             | 269 个测试文件／4358 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` AppleDouble 文件阻断             | 批量 Embeddings、Node 向量执行器、共享处理器鉴权与 staging 调度脚本（未执行）                                                  |
| 10   | WP-11        | 完成     | `72d86e6`、`a8164d3`、`187fc7d`、`614e588`、`1570a83` | 272 个测试文件／4375 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本子项代码文件 Prettier 定向检查通过；仓库级 format:check 被既有 36 个 `._*` AppleDouble 文件阻断   | 11-A、11-B、11-C、11-D 已完成；下一项 WP-08                                                                                    |
| 11   | WP-08        | 完成     | `68c0b54`                                             | 273 个测试文件／4385 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 文件定向 Prettier 通过；仓库级 format:check 被既有 `._*` 文件和未涉及文件阻断                 | 深度思考请求、reasoning SSE 进度、280 秒服务端预算、300 秒 Route Handler 上限、310 秒浏览器读取和 330 秒账本 TTL；开关默认关闭 |
| 12   | WP-14        | 待评审   | `9d6258f`                                             | 274 个测试文件／4393 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 文件定向 Prettier 通过；仓库级 format:check 被既有 36 个 `._*` 文件及 2 个未涉及文件阻断      | 代码与离线测试完成；等待 WP-02 真实模型人工抽查错误改标率与核验 p95                                                            |
| 13   | WP-13        | 待评审   | `a9a9dc2`、`dacc28d`                                  | 275 个测试文件／4401 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 文件定向 Prettier 通过；仓库级 format:check 被既有 36 个 `._*` 文件及 2 个未涉及文件阻断      | DEC-02；开关默认关；等待 WP-02 follow-up 人工评测                                                                              |
| 14   | WP-15        | 完成     | `b7de8ae`、`8fd9d83`                                  | Web 279 个测试文件／4412 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 文件定向 Prettier 通过；仓库级 format:check 被既有 `._*` AppleDouble 文件阻断             | PDF 书签与导入标题目录、版本级派生表与 API、问答 `sectionPath`；真实 PDF 云端浏览器验收未运行                                  |
| 15   | WP-16        | 待评审   | `09f2f13`、`62562b6`                                                 | Web 284 个测试文件／4427 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 文件定向 Prettier 通过；仓库级 format:check 被既有 36 个 `._*` AppleDouble 文件阻断 | 分层摘要、每日章节额度、版本级缓存、问答 summary grounding 与资料详情入口已完成；WP-02 summary 类别真实模型前后覆盖数字待人工记录 |
| 16   | WP-17        | 阻塞     | `c29d199`                                               | Web 定向整理回归 185 项通过；Web 全量 284 个测试文件／4431 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 文件定向 Prettier 通过；仓库级 format:check 被既有 `._*` 文件影响 | 代码已完成摘要导航、代表性原文证据、24 段／36,000 字符高预算边界与时间戳指纹；但 WP-16 迁移撤销了 `source_version_summaries` 对 `service_role` 的表权限，和 WP-17 要求 worker 直接查询冲突；需人工决定授权方式后再解除阻塞；未打开 staging 摘要开关 |
| 17   | WP-18        | 完成     | `94b88f4`                                               | Web 定向 151 项通过；全量 284 个测试文件／4436 项通过、1 项跳过（4438 项中 2 项跳过）；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 文件定向 Prettier 通过；仓库级 format:check 被既有 `._*` AppleDouble 文件阻断 | 默认关闭 `CONUO_FEATURE_KNOWLEDGE_NAVIGATION`；accepted 知识页最多 3 页／6 条当前原文引用进入 targeted/summary grounding；草稿、跨空间、旧版本与正文均被隔离；下一项 WP-19 |
| 18   | WP-19        | 未开始   |                                                       |                                                                                                                                                                                                  |                                                                                                                                |
| 19   | WP-20        | 未开始   |                                                       |                                                                                                                                                                                                  | 不改 PRD（DEC-12）                                                                                                             |
| 20   | WP-21        | 未开始   |                                                       |                                                                                                                                                                                                  | 本轮只做 21-1～21-3；21-1 完成后标待评审                                                                                       |
| 21   | WP-22        | 未开始   |                                                       |                                                                                                                                                                                                  |                                                                                                                                |
| 22   | WP-23        | 未开始   |                                                       |                                                                                                                                                                                                  |                                                                                                                                |
| 23   | WP-24        | 未开始   |                                                       |                                                                                                                                                                                                  |                                                                                                                                |
| 24   | WP-25        | 未开始   |                                                       |                                                                                                                                                                                                  | DEC-03；等 ANSWER_MEMORY 稳定                                                                                                  |
| 25   | WP-26        | 未开始   |                                                       |                                                                                                                                                                                                  |                                                                                                                                |
| 26   | WP-27        | 未开始   |                                                       |                                                                                                                                                                                                  |                                                                                                                                |
| 27   | WP-28        | 未开始   |                                                       |                                                                                                                                                                                                  | 只做服务端 grade_work                                                                                                          |
| 28   | WP-31        | 未开始   |                                                       |                                                                                                                                                                                                  | token 额度默认关闭                                                                                                             |
| —    | WP-12        | 本轮不做 |                                                       |                                                                                                                                                                                                  | DEC-07                                                                                                                         |
| —    | WP-29        | 本轮不做 |                                                       |                                                                                                                                                                                                  | DEC-08                                                                                                                         |
| —    | WP-30        | 本轮不做 |                                                       |                                                                                                                                                                                                  | DEC-08                                                                                                                         |
| —    | WP-40～WP-50 | 本轮不做 |                                                       |                                                                                                                                                                                                  | DEC-05、DEC-06、DEC-13                                                                                                         |

## 阶段门槛

| 阶段   | 状态                           | 记录                                                                                              |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| 阶段 0 | 完成                           | 离线检索评测通过；`grounding-v7` 基线总体及 15 类均为 1.0，`isolation` 100%，`single-late` 1.0    |
| 阶段 1 | 进行中                         | WP-11-A、WP-11-B、WP-11-C、WP-11-D、WP-08 已完成；WP-14、WP-13、WP-16 待评审；WP-17 阻塞；WP-15 已完成；下一项 WP-19 |
| 阶段 2 | 进行中                         | WP-15、WP-16 代码完成待评审；WP-17 阻塞；WP-18 已完成；下一项 WP-19                                                   |
| 阶段 3 | 本轮不做 21-4 起，不跑完整门槛 | DEC-04                                                                                            |
| 阶段 4 | 未开始                         |                                                                                                   |
| 阶段 5 | 本轮只做 WP-31                 | DEC-08                                                                                            |

## 人工事项

执行模型在这里写需要人做的事；人做完后把状态改成“已处理”并注明日期。

| 日期       | 状态   | 事项                                                                                                                                                                                       |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-23 | 已处理 | 已从 `staging` 创建本地分支 `feat/ai-enhancement`，并只提交本手册与本进度表。未推送。                                                                                                      |
| 2026-09-23 | 待处理 | 密钥与供应商账号由人创建：阿里云百炼 Embedding、硅基流动重排（DEC-10）。未配置前，相关 WP 的代码与测试仍可做，真实调用保持关闭。                                                           |
| 2026-09-23 | 待处理 | 部署时把 `CONUO_EMBEDDING_DAILY_CHAR_LIMIT` 设为 `2000000`（DEC-09）。代码默认值不要改。                                                                                                   |
| 2026-09-23 | 待处理 | staging 功能开关按 DEC-14 打开；本轮不要打开 `EXTERNAL_BODIES`。                                                                                                                           |
| 2026-09-24 | 待评审 | WP-14 需要人工用 WP-02 真实模型评测抽查逐段核验结果：错误改标少于 10%，并确认核验 p95 不超过 5 秒；评审前不要打开 staging 开关。                                                           |
| 2026-09-24 | 待评审 | WP-13 需要在 WP-02 增加并运行 follow-up 用例“再举一个不同的例子”：打开记忆后新例子应不同，且 `citationSupportRate` 不低于关闭时；满足前不要在 staging 打开 `CONUO_FEATURE_ANSWER_MEMORY`。 |
| 2026-09-24 | 待评审 | WP-16 需要用 WP-02 真实模型评测记录 `summary` 类别相对 WP-01 均匀抽样的 `keyPointCoverage` 前后数字，并确认章节摘要始终不进入可见引用；完成前不要在 staging 打开 `CONUO_FEATURE_SECTION_SUMMARIES`。 |
| 2026-09-24 | 待处理 | WP-17 阻塞：WP-16 迁移对 `public.source_version_summaries` 撤销了 `service_role` 表权限，但 WP-17 要求后台 worker 直接查询该表。请人类决定是否新增最小 `service_role` 只读授权（并补 SQL 回归），或提供手册允许的服务端读取契约；决定前保持 worker 摘要读取失败时回退 WP-01，且不要打开 staging 摘要开关。 |
| —          | 未到   | WP-21 的 21-1 完成后评审设计文档；通过条件见 DEC-04。未写“WP-21 设计评审通过”前不得开始 21-4。                                                                                             |
| —          | 未到   | 推送、部署、远程数据库迁移与 `supabase/operations/` 脚本（DEC-11）。                                                                                                                       |

## 工作笔记

- 2026-09-23：0.7 决策已写入手册并视为采纳。手册与进度表已在本地分支提交。实施尚未开始。
- 2026-09-23：完成 WP-01（提交 `4507833`）。自查通过：INV-01 证据来自规范 queues，INV-02 未改变 selectedSources 范围，`GROUNDING_CONTRACT_VERSION` 已升至 `grounding-v7`。下一项为 WP-02；待处理的供应商密钥、staging 开关、远程操作和 `._*` 工作树文件均未触碰。
- 2026-09-23：完成 WP-02。新增本地离线检索评测、真实模型评测入口、严格数据集 schema、报告写入和服务端功能开关；基线为 `grounding-v7` 总体及各类别 1.0，隔离违规 0。真实模型评测未启用，未访问外部网络。下一项为 WP-05。
- 2026-09-23：完成 WP-05。问答流新增 revision-only 探针，版本稳定时复用已加载快照，版本变化时只触发一次完整重载；已核对工作区写入版本递增前提，未访问外部网络。下一项为 WP-06。
- 2026-09-23：完成 WP-06。新增 `RICH_ANSWERS` 默认关闭的安全 Markdown／公式回答、服务端兜底净化、流式格式一致性和阅读器 KaTeX 渲染；`GROUNDING_CONTRACT_VERSION` 升至 `grounding-v8`，未运行真实模型评测。下一项为 WP-04。
- 2026-09-23：完成 WP-04。新增 AI 请求 metadata trace、provider token usage 解析与流式最终 usage 帧；trace 默认关闭，写入仅经 service_role RPC，指标白名单、证据引用上限和 30 天清理均有本地 SQL／路由测试。未访问外部模型、未执行迁移或部署。下一项为 WP-03。

- 2026-09-23：完成 WP-03。新增 `public.answer_feedback` 迁移、登录与账号状态保护的反馈／撤回 API、默认不带问题和回答的反馈控件，以及显式勾选后人工整理为评测样本的流程。功能开关默认关闭；未执行远程迁移、部署或真实云端反馈。下一项为 WP-07。

- 2026-09-23：完成 WP-07。模型适配器新增 `default`、`fast`、`reasoning`、`vision` 档位，支持可校验的输出上限、请求体上限、上下文预留字符数与 600 秒时限；问答、整理、后台整理和区域视觉均将实际档位写入请求指纹与 trace metadata。专用档位未配置时按手册回退，视觉专用档位保留独立能力开关；新增模型路由单测和环境配置文档。未访问外部模型，未执行部署或远程数据库操作。下一项为 WP-09。

## WP-02 自查

- [x] 仅新增评测目录、功能开关、脚本、`.env.example` 和实施记录；未改迁移、远程资源或手册决策。
- [x] 离线评测使用自编语料、固定请求和本地检索，纳入默认 `npm test`；模型评测显式开关关闭时跳过。
- [x] 数据集覆盖全部 15 个类别，长文档至少 40 节；基线文件记录 WP-01 后实测分数。
- [x] 没有创建或配置密钥；待处理的供应商密钥、staging 开关、推送部署事项仍保留在人工事项。

## WP-05 自查

- [x] 已核对所有现有 `public.workspaces` 更新 SQL 均递增 `revision`，版本探针前提成立。
- [x] 未改变模型、认证或接口契约；`requireUser(request)` 仍在每次复核中执行。
- [x] 版本稳定时只做 revision-only 查询；版本变化时重新加载完整工作区并沿用既有冲突终态。
- [x] 未修改迁移、远程资源、供应商密钥、staging 开关或本手册决策。

## WP-06 自查

- [x] `CONUO_FEATURE_RICH_ANSWERS` 服务端开关默认关闭；关闭时保留原有纯文本提示词和转义路径。
- [x] 富格式请求指纹包含 `format: "rich"`，`GROUNDING_CONTRACT_VERSION` 已从 `grounding-v7` 升至 `grounding-v8`。
- [x] 服务端只允许手册规定的 Markdown 子集；禁止节点、内部引用标记和正文 `[n]` 使用转义纯文本兜底，引用仍由服务端绑定。
- [x] 流式预览、最终绑定、阅读器公式解析和引用扫描使用一致的格式选项；KaTeX 禁止受信任 HTML 与外部资源。
- [x] 未修改保存 schema、移动端合同、迁移、远程资源、供应商密钥、staging 开关或本手册决策。

## WP-04 自查

- [x] `AI_TRACES` 默认关闭；关闭时模型请求体保持原样，`streamUsage` 默认 `false` 且不进入请求指纹。
- [x] 非流式与流式模型适配器解析 prompt/completion/total、reasoning 和 cache usage；流式只在显式开启时接受最终空 choices usage 帧，并通知首个 delta。
- [x] trace 只写 route、结果、模型元数据、检索／证据 ID、延迟和 token 计数；未知指标丢弃，证据引用最多 40 条，RPC 超时不影响主请求。
- [x] 新迁移启用 RLS、撤销私有表直接权限，仅 `service_role` 可执行写入 RPC；写入时清理 30 天前记录，metrics 上限 16 KiB。
- [x] 已覆盖 ask 的 completed/cached/extractive/cancelled 结果及 organize、organization-job、vision 的 observer 接入；未修改既有迁移、远程数据库、供应商密钥或部署资源。

## WP-03 自查

- [x] 新增反馈表启用 RLS，撤销直接写入权限；提交与撤回 RPC 校验登录、账号注销状态、请求 ID、原因和内容附带条件。
- [x] 默认反馈请求只发送评分、原因和必要的回答标识；只有勾选后才发送问题与回答，SQL check 和路由 schema 双重拒绝隐式内容。
- [x] 功能开关关闭时反馈控件不渲染；已覆盖路由输入、会话变更、RPC 参数、账号隔离、重复 requestId、无效原因和组件撤回。
- [x] 已在 `apps/web/eval/README.md` 记录只读导出与人工去标识整理流程；未新增自动导出、密钥、远程迁移或部署。

## WP-07 自查

- [x] `readModelProfile` 保留现有默认变量行为；`fast`／`reasoning` 未配置时回退 `default`，`vision` 遵循专用开关与旧 `CONUO_MODEL_VISION_ENABLED` 组合。
- [x] 输出 token、请求体、上下文字符数和超时均做边界校验；请求指纹追加实际档位，路由 trace 使用同一档位名。
- [x] 组织路由与后台执行器接受 `CONUO_ORGANIZATION_MODEL_PROFILE=default|fast`，默认 `default`；所有相关测试 mock 已补齐新导出。
- [x] `docs/MODEL_SETUP.md` 与 `apps/web/.env.example` 已同步全部档位变量；未创建密钥、未执行迁移、远程数据库操作、部署或外部模型调用。

- 2026-09-23：完成 WP-10。新增批量 Embeddings 边界、Node.js 向量任务执行器、共享处理器鉴权和内部入口；定向与全量本地检查通过。staging 调度 SQL 仅加入仓库，未执行远程操作。下一项为 WP-11。

- 2026-09-23：完成 WP-11-A。定向问题支持按开关扩展最多 4 个命中及其前后邻段，保持同资料、版本、范围与上下文预算约束；问答指纹记录 neighbor 半径。下一项为 WP-11-D。

- 2026-09-23：完成 WP-11-D。跨库问答在开关打开且固定 1–5 份资料时使用 `p_space_id="*"` 与固定 `p_source_ids` 做关键词／语义 RRF；普通非 AI 全库和超过 5 份资料仍拒绝语义检索。下一项为 WP-11-B。

- 2026-09-23：完成 WP-11-B（代码提交 `187fc7d`、`614e588`）。新增 `query-rewrite.ts` 与 `rewrite-v1` 严格 JSON 合同；连续追问和跨文字体系问题在开关打开且有模型配置时先预占一次账本，再用独立查询与备用查询检索并用 RRF 合并；格式错误或 10 秒超时回退原查询，缓存命中不调用改写；无证据时关闭提前预占的账本占用。下一项为 WP-11-C；未打开 staging 开关、未执行真实模型或远程操作。

- 2026-09-23：完成 WP-11-C（代码提交 `1570a83`）。新增默认关闭的重排适配器和配置边界；启用且配置完整时，问答先对最多 40 条检索片段重排，再使用原有 12 条／24,000 字符证据预算；调用失败保留原检索顺序。设置页和模型配置文档记录第三方服务的数据边界，trace 与请求指纹记录实际重排配置。R-15 全量测试 272 个文件／4375 项通过、2 项跳过；下一项为 WP-08；未配置供应商密钥、未打开 staging 开关、未执行真实模型或远程操作。

- 2026-09-23：完成 WP-08。新增 `depth: standard|deep` 请求字段（范围快照不保存该字段）；深度请求在 server/UI 开关打开且使用 SSE 时选择 `reasoning` 档位，动态预算为 280 秒，Route Handler 上限 300 秒，浏览器读取上限 310 秒，账本 TTL 330 秒；非流式深度请求返回 `DEEP_REQUIRES_STREAM`。模型 `reasoning_content` 只发送最多每 5 秒一次的 `reasoning` 进度事件，不进入回答、草稿或保存结果；新增 TTL 迁移和 PGlite SQL 验证。R-15 全量测试 273 个文件／4385 项通过、2 项跳过；下一项为 WP-14。未打开深度开关、未配置 reasoning 密钥、未执行远程迁移或部署。

- 2026-09-24：完成 WP-14 代码与离线验证。`bindGeneratedAnswer` 拆为解析与渲染两步；`ANSWER_VERIFY` 打开时用 `fast` 档位逐段核对原文引用，unsupported 原文段落加“推断（原文未直接支持，请核对）”标签，证据单条截断 2,000 字符、总输入上限 60,000 字符；超时、模型错误保留原回答，取消继续中止请求；指纹追加 `verify-v1`，trace 保留核验耗时和 skipped 标记。下一项为 WP-13。WP-02 真实模型人工抽查和 p95 仍待评审；未打开 staging 开关、未执行真实模型或远程操作。
- 2026-09-24：完成 WP-13 本地实现。新增可选 `conversationId`（不进入范围快照）；`ANSWER_MEMORY` 打开时服务端仅读取同空间、同范围会话中最近 2 条已完成模型回答，清理覆盖说明和引用标记，当前版本且当前范围的原引用重新校验后才加入证据；历史回答只作为不可信、非证据的 `priorAssistantAnswers`，浏览器不提交回答文字。阅读器、比较问答和跨库问答均传递保存后的会话 ID；请求指纹追加 `memory:key`；按 DEC-02 修订 PRD 三处文字及流式问答说明。下一项为 WP-15。WP-02 follow-up 人工评测和 staging 开关仍待评审；未执行真实模型、部署或远程操作。
- 2026-09-24：完成 WP-15 本地实现。新增按资料版本绑定的 `source_outlines` 派生表、owner-scoped 目录 RPC 与 API；PDF.js 书签和导入时字号标题目录在云端确认后保存，阅读器目录支持按页跳转；问答证据保留 `section`／`page` 并在可对应时增加 `sectionPath`，指纹包含目录更新时间，`GROUNDING_CONTRACT_VERSION` 升至 `grounding-v10`。Web R-15：279 个测试文件／4412 项通过、2 项跳过，typecheck 通过，lint 0 错误并保留 1 条既有 `_result` 警告；仓库级 `format:check` 仍被既有 `._*` AppleDouble 文件阻断。未执行真实 PDF 云端浏览器验收、远程迁移或部署；下一项为 WP-16。

- 2026-09-24：完成 WP-16 代码与离线验证。新增版本绑定的 `source_version_summaries`、私有摘要任务与每日章节额度，按目录或顺序窗口生成章节摘要再汇总全书；摘要只作为 `sectionSummaries` 导航提示，问答可见引用仍只绑定原文切块，摘要不存在时回退 WP-01 检索。新增后台处理入口、用户摘要 API、资料详情面板、staging 调度脚本与 `docs/SUMMARIES.md`；`GROUNDING_CONTRACT_VERSION` 升至 `grounding-v11`。Web R-15：284 个测试文件／4427 项通过、2 项跳过，typecheck 通过，lint 0 错误并保留 1 条既有 `_result` 警告；仓库级 `format:check` 仍被既有 `._*` AppleDouble 文件阻断。未执行真实模型评测、远程迁移或部署；下一项为 WP-17。

- 2026-09-24：WP-17 本地实现完成但标记阻塞。`buildOrganizationGrounding` 在摘要开关打开且存在当前版本全书摘要时，按资料分配代表性原文切块，并把章节摘要作为不可信、不可引用的 `sectionSummaries` 传入整理提示；摘要缺失或读取失败时保留 WP-01 路径。`maxRequestBytes >= 524288` 时使用 24 段／36,000 字符，否则保持 12 段／24,000 字符；交互式与后台整理指纹追加摘要创建时间，`ORGANIZATION_MODEL_CONTRACT_VERSION` 升至 `organization-v3`。定向 185 项、全量 4431 项通过；发现 WP-16 对摘要表撤销 `service_role` 表权限，与 WP-17 后台直接查询要求冲突，等待人工决定授权方式。未打开 staging 开关、未执行远程迁移／operations 脚本、部署或真实模型评测；下一项为 WP-18。

- 2026-09-24：完成 WP-18 本地实现。`CONUO_FEATURE_KNOWLEDGE_NAVIGATION` 默认关闭；开启后问答只在 `space`、`sources`、`document` 范围搜索前 20 个知识页候选，取前 3 个 accepted 且未删除、属于当前空间的知识页，再把最多 6 条仍绑定当前资料版本的原文引用加入 targeted/summary grounding。知识页正文不会进入提示词；草稿、跨空间、旧版本与不在 selectedSources 的引用均被丢弃。请求指纹加入导航引用签名，AI trace 记录导航引用数；定向 151 项通过，R-15 全量结果见 WP-18 状态行。未打开 staging 开关、未执行远程迁移／operations 脚本、部署或真实模型评测；下一项为 WP-19。

## WP-16 自查

- [x] 摘要表、任务表和每日额度表按 owner／资料／不可变版本隔离，启用 RLS、撤销直接权限；资格与租约写入使用既有 `PT409` 冲突契约，版本删除级联清理摘要。
- [x] 章节切分覆盖有目录、无目录、超长章节和 60 章上限；章节模型输出与全书 reduce 都把模型 `e` 编号绑定回真实原文切块，越界编号和 `s` 编号被拒绝。
- [x] 执行器按额度、剩余时间和租约续期边界分步处理，额度耗尽保留已完成章节，下一次领取继续未完成章节；处理器复用 WP-10 鉴权并限制每次最多一个任务。
- [x] 问答仅在开关、单资料、摘要意图或章节问题且存在全书摘要时使用 `summary` layout；章节摘要进入导航 JSON，显式证据与最终引用只允许 `e`／`n`，无摘要回退原有检索。
- [x] 已新增摘要 API、资料详情入口、每日额度与删除／证据边界文档；未打开 staging 开关、未执行远程迁移／operations 脚本、未调用外部模型。WP-02 `summary` 类别的真实模型前后覆盖数字仍待人工评审。

## WP-17 自查

- [x] `organization-v3` 只扩展整理输入导航和证据预算，四种 `organization-v2` 输出结构、严格 schema 与服务端引用绑定保持不变。
- [x] 有当前版本全书摘要时按资料分配代表性原文切块；章节摘要标为不可信导航数据，不进入 `organizationCitations`；无摘要或读取失败时回退 WP-01 证据。
- [x] `maxRequestBytes` 达到 524288 才启用 24 段／36,000 字符上限；其他档位保持 12 段／24,000 字符；摘要创建时间进入交互式与后台 worker 指纹。
- [x] 用户路由使用 `read_source_summaries`；后台 worker 已实现 service role 当前版本直读尝试及失败回退；已覆盖交互式路由、后台 worker、跨资料分布和摘要隔离测试；未打开 staging、未执行远程操作或真实模型调用。
- [ ] WP-16 迁移撤销了 `source_version_summaries` 对 `service_role` 的表权限；后台直读所需的最小授权方式待人工决定，决定前 WP-17 保持阻塞。

## WP-18 自查

- [x] `CONUO_FEATURE_KNOWLEDGE_NAVIGATION` 默认关闭；关闭时不搜索知识页、不改变 grounding 或请求指纹。
- [x] 只对 `space`、`sources`、`document` 范围取前 20 个知识页候选，再限制前 3 个 accepted、未删除且属于当前空间的页面；收件箱、草稿、跨空间和旧版本均不进入导航。
- [x] 每个知识页只贡献当前 selectedSources 内、`resolveCitation` 成功的原文引用，最多 6 条；grounding 只使用 canonical 原文，知识页正文不会进入模型消息。
- [x] 导航引用签名进入请求指纹，trace 记录 `navigationCount`；已覆盖 targeted/summary 顺序、过滤、指纹变化、trace 和功能开关关闭回归；未打开 staging、未执行远程操作或真实模型调用。

## WP-11-D 自查

- [x] `CROSS_LIBRARY_SEMANTIC` 默认关闭；关闭时跨库问答保持关键词路径，普通非 AI 全库语义请求仍返回 `SEMANTIC_SCOPE_REQUIRED`。
- [x] 开关打开时仅放行 `forAI` 且候选资料不超过 5 份的 `all` 范围；语义 RPC 使用固定 `p_space_id="*"` 与已筛选的 `p_source_ids`。
- [x] 已覆盖开关关闭、开启后的固定源 ID、非 AI 全库拒绝和五份上限；未打开 staging 开关，未执行部署、远程数据库或模型调用。

## WP-11-A 自查

- [x] buildGrounding 仅在最后的定向问题分支使用 neighborRadius=1；最多扩展前 4 个命中，邻段按同一资料队列查找，首尾不越界并去重。
- [x] CONUO_FEATURE_NEIGHBOR_EXPANSION 默认关闭；关闭时证据顺序与数量保持原逻辑，问答指纹明确记录 neighbor:0。
- [x] 已覆盖中心命中、首段边界、关闭开关和问答指纹；未打开 staging 开关，未执行部署、远程数据库或模型调用。

## WP-11-B 自查

- [x] `QUERY_REWRITE` 默认关闭；触发判断覆盖 userContext 短问题、指代词和跨文字体系，改写提示词只接收问题与既往用户问题，不接收资料原文。
- [x] 改写输出使用 `rewrite-v1` 严格 schema；非法 JSON、模型错误和 10 秒超时回退 `answerRetrievalQuery`，trace 记录 `rewrite: false`。
- [x] 每个查询独立调用 `indexedSourceCandidates`，结果通过导出的 `fuseCandidates` RRF 去重；改写、回答共用一次账本预占，缓存命中不执行改写。
- [x] 关闭开关回归与 11-B 定向测试已通过；未打开 staging 开关，未执行部署、远程数据库或模型调用。

## WP-11-C 自查

- [x] `CONUO_FEATURE_RERANK` 默认关闭；未启用或配置不完整时保留原检索顺序，启用后只把问题和最多 2,000 字符的检索片段交给独立重排服务。
- [x] 重排配置校验 HTTPS／本机回环 HTTP、候选数 8–64、返回数 4–24；适配器限制请求／响应 256 KiB、10 秒超时、手动重定向和索引唯一性／范围；不自动重试。
- [x] 问答在重排后继续执行既有 12 条／24,000 字符证据预算；失败回退原顺序，trace 记录 `rerank`，请求指纹隔离重排配置。
- [x] 已覆盖配置、请求体、排序、重复／越界索引、成功重排和失败回退；R-15 全量检查完成。未创建密钥，未打开 staging 开关，未执行迁移、远程操作、部署或外部模型调用。

## WP-08 自查

- [x] 新增 `20260924000300_ai_request_ttl.sql`，只新增迁移；保留四参数调用兼容，默认 TTL 120 秒，深度调用使用 330 秒，TTL 边界和显式过期由 PGlite 覆盖。
- [x] `depth` 只进入请求校验、路由和指纹；`AnswerScopeSnapshot` 保持不含深度字段，重试由当前面板状态决定。
- [x] 深度请求必须 SSE；普通 55 秒、深度 280 秒、Route Handler 300 秒、浏览器 310 秒的边界已分别落实；reasoning 增量不进入回答正文、草稿或账本结果，进度最多每 5 秒一次。
- [x] 通用问答面板只在 `NEXT_PUBLIC_CONUO_FEATURE_DEEP_THINKING=on` 时显示“深度思考”，server/UI 开关默认关闭；未配置密钥、未打开 staging、未执行远程迁移、部署或真实模型调用。

## WP-14 自查

- [x] `parseGeneratedAnswer` 保留原有 JSON、引用范围、kind/id 一致性、引用上限与量化自评校验；`renderGeneratedAnswer` 保持既有正文、引用编号和笔记标记输出，新增标签只作用于被核验标为 unsupported 的 source 段落。
- [x] `answer-verification.ts` 只发送 source 段落及其 canonical 引用文本；每条证据最多 2,000 字符、总核验输入最多 60,000 字符，使用 `verify-v1` 严格 JSON 合同并丢弃未发送段落的返回编号。
- [x] `CONUO_FEATURE_ANSWER_VERIFY` 默认关闭；开启时请求指纹追加 `verify-v1`，快速档位调用使用最多 15 秒的独立取消信号；超时或其他核验错误保留原回答，用户取消继续抛出取消错误，缓存结果不重复核验。
- [x] 预览仍使用原有 grounding preview，标签只在最终 `complete`／非流式完整响应中出现；未增加 SSE 事件。
- [ ] 待人工用 WP-02 真实模型评测抽查错误改标率低于 10%，并确认核验 p95 不超过 5 秒；未打开 staging 开关、未执行部署或远程操作。

## WP-13 自查

- [x] `conversationId` 只从已保存会话读取；`AnswerScopeSnapshot` 不包含会话 ID，浏览器提交的回答文字不进入请求。
- [x] 只取同空间、同范围会话中最近 2 条已完成模型回答；失败、停止、原文摘录、覆盖说明和历史引用标记均不进入记忆。
- [x] 历史引用经 `resolveCitation`、当前版本和 `selectedSources` 重新校验，并在 grounding 中排在检索命中之后；`assertAnswer` 规则未放宽。
- [x] `priorAssistantAnswers` 只进入用户 JSON；系统提示声明其不可信、非证据，注入回归确认文字不会进入系统消息。
- [x] `ANSWER_MEMORY` 默认关闭；关闭时提示词、grounding 顺序和请求指纹保持原路径；请求指纹打开时追加 `memory:key`。
- [x] 按 DEC-02 修改 `docs/PRD.md` 的 ASK-07、7.7 段落、AT-35 三处，并更新 `docs/STREAMING_ANSWERS.md` 连续追问边界。
- [x] 未修改迁移、远程资源、供应商密钥、staging 开关或本手册决策；WP-02 follow-up 和 staging 开关保留人工评审。

## WP-15 自查

- [x] `source_outlines` 按 owner、资料和不可变版本绑定，启用 RLS、撤销直接访问，仅 authenticated 可执行保存／读取 RPC；严格校验目录方法、项数、标题、层级和 1–100000 页码，历史版本清理级联删除。
- [x] PDF.js 书签按深度优先展开并限制 6 层／1000 项；读取失败只跳过单项；无书签时新导入 PDF 用字号中位数启发式识别最多 300 个标题，Markdown／DOCX 目录仅存内存结果并在云端确认后保存。
- [x] 阅读器只在当前版本、登录且云端保存确认后读写目录；目录项点击按页跳转，目录失败不阻断原始 PDF 阅读；问答只把服务端读取的目录用于 `sectionPath`，原有 `section`／`page` 和引用绑定保持不变。
- [x] `GROUNDING_CONTRACT_VERSION` 已升至 `grounding-v10`，目录更新时间进入请求指纹；已覆盖目录展开、标题识别、SQL owner／匿名／非法输入／级联、路由校验及无目录证据回归；未修改已有迁移、远程数据库、供应商密钥或部署资源。

## WP-10 自查

- [x] EmbeddingConfig 新增 dimensionsParam 与 batchSize；默认关闭 dimensions 参数时保留旧 fingerprint，开启时追加 dimensions-param。
- [x] embedTexts 严格校验批量大小、文本字符数、UTF-8 总字节、响应大小、索引唯一性、1536 维向量有限值和非零约束；供应商状态按手册映射为可重试或拒绝。
- [x] Node runner 复用 embedding_jobs RPC 的租约、心跳、字符额度、分批提交、连续 cursor、失败退避和 finish 发布语义；共享处理器鉴权已由 organization-processor 复用。
- [x] 新内部入口和 staging 操作脚本已加入；未执行远程 SQL、迁移、部署或调度，未创建密钥。

## WP-09 自查

- [x] `Grounding` 明确区分 `retrieval` 与 `full-document`；完整布局只接受规范切块、限定资料数和 `contextChars` 预算，失败自动回退现有检索路径。
- [x] 完整布局消息按系统规则、静态证据、动态问题三条发送；静态前缀不包含问题或覆盖说明变化，引用编号与选段编号仍由服务端数据生成。
- [x] `bindGeneratedAnswer` 对去重后的原文引用执行 12 条上限；问答指纹加入布局，trace 只在实际使用完整布局时记录 `longContext: true`。
- [x] `CONTEXT_CHARS` 的估算、UTF-8 预检查、0.8 请求体阈值及输入 token／延迟／费用影响已写入 `docs/MODEL_SETUP.md`；未修改迁移、远程资源、供应商密钥或 staging 开关。
