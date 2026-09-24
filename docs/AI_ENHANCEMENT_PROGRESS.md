# AI 增强实施进度

决策以 [AI_ENHANCEMENT_PLAN.md](AI_ENHANCEMENT_PLAN.md) 第 0.7 节为准。执行模型更新本表，不改手册。人类改决策时改 0.7，并在下面“人工事项”写日期与原因。

| 项         | 值                                      |
| ---------- | --------------------------------------- |
| 分支       | `feat/ai-enhancement`（本地，未推送）   |
| 下一个 WP  | WP-11-D                                 |
| 当前阶段   | 阶段 0 已完成；阶段 1 进行中            |
| 更新日期   | 2026-09-23                              |

## 工作包状态

状态取值：`未开始` / `进行中` / `完成` / `阻塞` / `待评审` / `本轮不做`。

| 顺序 | WP     | 状态     | 提交 | 测试 | 备注 |
| ---- | ------ | -------- | ---- | ---- | ---- |
| 1    | WP-01  | 完成     | `4507833` | 255 个测试文件／4264 项通过；typecheck、lint 通过；本 WP 文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` 文件和 12 个未涉及文件阻断 | 定向问题、摘要、选段、比较、跨语言和 10 资料整理回归通过 |
| 2    | WP-02  | 完成     | `7e06567` | 258 个测试文件／4269 项通过；模型评测 1 个文件跳过；typecheck 通过；lint 0 错误、1 条既有警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` 文件和 12 个未涉及文件阻断 | 76 条自编用例、15 类覆盖；`grounding-v7` 总体和各类命中率 1.0；隔离违规 0；真实模型评测未运行 |
| 3    | WP-05  | 完成     | `046898e` | 258 个测试文件／4272 项通过；typecheck 通过；lint 0 错误、1 条既有警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` 文件和未涉及文件阻断 | revision-only 探针；版本稳定时复用快照，变化时完整重载；无功能开关 |
| 4    | WP-06  | 完成     | `a2e8bd1` | 260 个测试文件／4288 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` 文件和未涉及文件阻断 | `RICH_ANSWERS` 默认关闭；安全 Markdown、公式与 KaTeX；`grounding-v8`；未运行真实模型评测 |
| 5    | WP-04  | 完成     | `d493348`、`0c1ffc1` | 262 个测试文件／4301 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 36 个 `._*` AppleDouble 文件阻断 | AI 请求 trace、provider usage、流式最终 usage 帧；30 天清理与 service_role RPC；默认关闭 |
| 6    | WP-03  | 完成     | `3a81562` | 265 个测试文件／4310 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有警告；新增文件定向 Prettier 通过；仓库级 format:check 被既有 36 个 `._*` AppleDouble 文件阻断 | 回答反馈、显式内容附带、撤回和人工转评测流程；阶段 0 离线门槛通过 |
| 7    | WP-07  | 完成     | `73d41a3` | 266 个测试文件／4323 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 36 个 `._*` AppleDouble 文件阻断 | 四档模型配置、问答／整理／后台整理／区域视觉路由档位指纹隔离；真实模型与部署未验收 |
| 8    | WP-09  | 完成     | `2edfa43` | 267 个测试文件／4328 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 变更文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` AppleDouble 文件阻断 | 完整资料长上下文、静态前缀与服务端引用上限；未运行真实模型评测 |
| 9    | WP-10  | 完成     | `9cbbc69` | 269 个测试文件／4358 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本 WP 文件 Prettier 定向检查通过；仓库级 format:check 被既有 `._*` AppleDouble 文件阻断 | 批量 Embeddings、Node 向量执行器、共享处理器鉴权与 staging 调度脚本（未执行） |
| 10   | WP-11  | 进行中   | `72d86e6` | 269 个测试文件／4360 项通过、2 项跳过；typecheck 通过；lint 0 错误、1 条既有 `_result` 警告；本子项代码文件 Prettier 定向检查通过；仓库级 format:check 被既有 36 个 `._*` AppleDouble 文件阻断 | 11-A 邻段扩展完成；下一子项 11-D |
| 11   | WP-08  | 未开始   |      |      |      |
| 12   | WP-14  | 未开始   |      |      |      |
| 13   | WP-13  | 未开始   |      |      | DEC-02；开关默认关 |
| 14   | WP-15  | 未开始   |      |      |      |
| 15   | WP-16  | 未开始   |      |      |      |
| 16   | WP-17  | 未开始   |      |      |      |
| 17   | WP-18  | 未开始   |      |      |      |
| 18   | WP-19  | 未开始   |      |      |      |
| 19   | WP-20  | 未开始   |      |      | 不改 PRD（DEC-12） |
| 20   | WP-21  | 未开始   |      |      | 本轮只做 21-1～21-3；21-1 完成后标待评审 |
| 21   | WP-22  | 未开始   |      |      |      |
| 22   | WP-23  | 未开始   |      |      |      |
| 23   | WP-24  | 未开始   |      |      |      |
| 24   | WP-25  | 未开始   |      |      | DEC-03；等 ANSWER_MEMORY 稳定 |
| 25   | WP-26  | 未开始   |      |      |      |
| 26   | WP-27  | 未开始   |      |      |      |
| 27   | WP-28  | 未开始   |      |      | 只做服务端 grade_work |
| 28   | WP-31  | 未开始   |      |      | token 额度默认关闭 |
| —    | WP-12  | 本轮不做 |      |      | DEC-07 |
| —    | WP-29  | 本轮不做 |      |      | DEC-08 |
| —    | WP-30  | 本轮不做 |      |      | DEC-08 |
| —    | WP-40～WP-50 | 本轮不做 |  |      | DEC-05、DEC-06、DEC-13 |

## 阶段门槛

| 阶段   | 状态   | 记录 |
| ------ | ------ | ---- |
| 阶段 0 | 完成   | 离线检索评测通过；`grounding-v7` 基线总体及 15 类均为 1.0，`isolation` 100%，`single-late` 1.0 |
| 阶段 1 | 进行中 | WP-11-A 已完成；下一项 WP-11-D |
| 阶段 2 | 未开始 |      |
| 阶段 3 | 本轮不做 21-4 起，不跑完整门槛 | DEC-04 |
| 阶段 4 | 未开始 |      |
| 阶段 5 | 本轮只做 WP-31 | DEC-08 |

## 人工事项

执行模型在这里写需要人做的事；人做完后把状态改成“已处理”并注明日期。

| 日期       | 状态   | 事项 |
| ---------- | ------ | ---- |
| 2026-09-23 | 已处理 | 已从 `staging` 创建本地分支 `feat/ai-enhancement`，并只提交本手册与本进度表。未推送。 |
| 2026-09-23 | 待处理 | 密钥与供应商账号由人创建：阿里云百炼 Embedding、硅基流动重排（DEC-10）。未配置前，相关 WP 的代码与测试仍可做，真实调用保持关闭。 |
| 2026-09-23 | 待处理 | 部署时把 `CONUO_EMBEDDING_DAILY_CHAR_LIMIT` 设为 `2000000`（DEC-09）。代码默认值不要改。 |
| 2026-09-23 | 待处理 | staging 功能开关按 DEC-14 打开；本轮不要打开 `EXTERNAL_BODIES`。 |
| —          | 未到   | WP-21 的 21-1 完成后评审设计文档；通过条件见 DEC-04。未写“WP-21 设计评审通过”前不得开始 21-4。 |
| —          | 未到   | 推送、部署、远程数据库迁移与 `supabase/operations/` 脚本（DEC-11）。 |

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

## WP-11-A 自查

- [x] buildGrounding 仅在最后的定向问题分支使用 neighborRadius=1；最多扩展前 4 个命中，邻段按同一资料队列查找，首尾不越界并去重。
- [x] CONUO_FEATURE_NEIGHBOR_EXPANSION 默认关闭；关闭时证据顺序与数量保持原逻辑，问答指纹明确记录 neighbor:0。
- [x] 已覆盖中心命中、首段边界、关闭开关和问答指纹；未打开 staging 开关，未执行部署、远程数据库或模型调用。

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
