# 生产发布手册

更新时间：2026-09-20。本页只记录可复核的发布状态、闸门和操作顺序；它不授权生产变更，也不保存密钥。

## 当前结论

生产数据库还不能升级。当前需要先处理的不是再次部署代码，而是冻结生产代码漂移、完成可恢复备份演练，并让生产数据库、Vercel 变量、Auth 回调和调度一起进入同一发布版本。

2026-09-20 的只读核对结果：

| 项目             | staging                                    | 原生产                                                 |
| ---------------- | ------------------------------------------ | ------------------------------------------------------ |
| Vercel 项目      | `conuo-staging`                            | `conuo`                                                |
| Git 来源         | `DingxinTao0417/conuo` / `staging`         | `DingxinTao0417/conuo` / `main`                        |
| 完整验收基线部署 | `dpl_9GAVHE5U2b3jq5WLTK8TpDQgQdhq`         | —                                                      |
| 基线 Git 提交    | `5f6b50ff99ae558cf2738a053dea79fb2fcfe77a` | `0c2474e1e36cfe4b3715629dd9fd5e62daeb66f2`             |
| 当前域名版本     | `/api/health` 实时返回分支与完整 SHA       | 尚未建立同等发布探针记录                               |
| 数据库迁移       | 27 份，已核验                              | 最后一次只读核验为 19 份；发布前须重新实时核对         |
| Vercel 变量      | 16 个，仅 Production                       | 19 个，Production 与 Preview（Preview 自动部署已关闭） |
| 清理 Cron        | 三条已注册，手动触发 200                   | 三条也已随同一 `vercel.json` 注册                      |
| 发布结论         | 测试环境                                   | 代码已自动部署，但数据库未确认升级，不构成正式发布     |

staging 已改为跟随 `staging` 分支，原生产项目继续跟随 `main`；原生产项目的 Preview 自动部署已关闭。因此后续推送 `staging` 只会触发 staging Production 部署，不会再向原生产项目创建 Preview。当前生产网页代码已经前进到 27 份迁移对应版本，不能继续用“生产代码未部署”描述；尚未升级的是生产数据库和配套运行配置。

## 首要处置：冻结生产代码漂移

发布职责已经分开，当前配置为：

- `conuo-staging` 从 `staging` 自动部署，已用提交 `5f6b50ff99ae558cf2738a053dea79fb2fcfe77a` 验证 Git 自动部署；提交 `d64ee3f76bdb24cdfcfed76cbd958a615183feb5` 又验证 `/api/health` 能从实际运行实例返回 `production`、`staging` 和完整 SHA。
- `conuo` 改用受保护的 `production` 分支，或断开自动 Git 部署后只接受经过验收的明确晋升。
- `conuo` 继续从 `main` 接收生产部署；生产发布记录固定 Git SHA、数据库迁移上界和 Vercel Deployment ID，不能用可变的“最新 main”代替发布版本。
- staging 验收通过后，由同一不可变提交进入生产；生产数据库升级和生产代码晋升属于同一维护窗口。

修改生产 Vercel 的 Git 连接或 Production Branch 会改变外部发布行为，须作为单独获批的生产操作执行。当前仍不能向 `main` 推送未验收代码。

## 生产数据库增量

若发布前实时核对仍为 19 份迁移，生产需要顺序应用以下 8 份，不能跳过、改写或重新编号：

| 顺序 | 迁移                                                      | 作用与发布风险                                                              |
| ---- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| 20   | `20260914000800_fast_workspace_saves.sql`                 | 有界工作区忙写、减少无变化投影重建；改变保存冲突与性能路径                  |
| 21   | `20260914120601_upload_intents.sql`                       | 上传预留、精确配额、Storage INSERT 约束和孤立上传清理租约                   |
| 22   | `20260914120700_organization_jobs.sql`                    | 持久资料／知识整理任务、租约、结果提交与发布                                |
| 23   | `20260915045450_annotation_utf16_text_anchors.sql`        | 批注 UTF-16 原文锚点和只读投影                                              |
| 24   | `20260915060323_source_purge_saved_content_selection.sql` | 彻底删除时选择关联笔记、知识页和对话，并防止旧快照复活                      |
| 25   | `20260920000100_storage_upload_preflight.sql`             | 兼容 Supabase Storage 上传预检的 `metadata.contentLength`，保留最终大小核验 |
| 26   | `20260920000200_workspace_conflict_response.sql`          | 工作区业务冲突从显式 `40001` 改为快速 `PT409`                               |
| 27   | `20260920000300_business_conflict_response.sql`           | 其余 49 个显式业务冲突统一为 `PT409`，真实引擎序列化失败语义不变            |

发布前必须从生产迁移历史重新计算缺口。若远端已出现未知迁移、同名不同内容或顺序分叉，应停止发布并先查明来源。

## 环境变量差异

只读核对显示，两个项目共有 15 个变量。差异如下：

| 差异                          | 当前状态                                            | 发布处理                                                                              |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `CRON_SECRET`                 | staging 有，生产没有                                | 生产三条 Vercel Cron 需要它发送 Bearer；值必须与路由实际校验的清理密钥一致            |
| 四个 `CONUO_EMBEDDING_*` 变量 | 生产有，staging 没有                                | 决定首发是否启用语义索引；启用前必须在 staging 配同供应商并完成真实质量与删除隔离验收 |
| 变量目标                      | staging 仅 Production；生产覆盖 Production、Preview | Preview 不应默认持有生产数据库和服务端密钥；发布前按最小权限拆分                      |

生产当前缺少 `CRON_SECRET`，而代码优先使用 `CONUO_CLEANUP_SECRET` 校验三条清理路由。Vercel 只会把平台变量 `CRON_SECRET` 作为 Cron 的 Bearer 发送；仅存在 `CONUO_CLEANUP_SECRET` 不会自动生成该请求头。不能现在单独补变量：迁移 21 尚未确认存在时，上传预留清理路由没有完整数据库依赖。应在维护窗口中先完成备份和迁移，再一起配置并验证 Cron。

生产还需要逐项核对以下值指向生产资源且彼此匹配，但不得在日志、文档或聊天中打印真实值：

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `CONUO_MODEL_*`
- `CONUO_AI_DAILY_REQUEST_LIMIT`
- `CONUO_PROCESSOR_SECRET`
- `CONUO_CLEANUP_SECRET`
- `CRON_SECRET`
- `NEXT_PUBLIC_CONUO_ORGANIZATION_PROCESSOR_ENABLED`
- `NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED=false`

## 备份与恢复闸门

staging Supabase 当前为 Free 方案，不包含计划数据库备份；控制台的 “Restore to a new project” 需要 Pro 和可用物理备份。本机当前也没有 `pg_dump`、`pg_restore`、`psql`、Supabase CLI 登录 token 或数据库密码。因此“已备份”与“已恢复验证”目前都不成立。

生产发布只能选择以下一种经过实测的方案：

1. 升级到支持物理备份的方案，在新项目恢复，并核对 Auth、业务表、私有 schema、Storage 元数据、对象字节和权限。
2. 使用官方 PostgreSQL 工具和受控数据库连接完成逻辑导出；在全新隔离 Supabase 项目恢复，随后单独复制并校验私有 Storage 对象。

应用内个人 ZIP 只能恢复用户业务副本，不能替代数据库灾难恢复。仅导出 `public` 表或调用 REST 逐表下载也不完整，因为它不会证明 Auth、`conuo_private`、函数、触发器、策略、扩展和 Storage 对象可恢复。

恢复演练必须留下不含密钥的记录：

- 源项目、目标隔离项目、导出时间和 Git SHA。
- schema、数据和 Storage 对象清单及校验方式。
- 从零顺序应用全部 27 份迁移的结果。
- 两个测试账号的登录、RLS 隔离、原件下载、工作区读取和 AI 账本抽查。
- 三条清理队列与整理任务的空队列／可重试状态。
- 演练资源的保留或删除终态。

## 发布前闸门

以下项目全部满足后，才进入生产维护窗口：

- [x] 生产 Vercel 不再跟随 staging 的 `main` 自动漂移；staging 使用 `staging`，原生产使用 `main`，生产 Preview 自动部署已关闭。
- [x] Git 自动部署和精确 SHA 探针已通过；完整验收基线部署 `dpl_9GAVHE5U2b3jq5WLTK8TpDQgQdhq` 对应 SHA `5f6b50ff99ae558cf2738a053dea79fb2fcfe77a`，`/api/health` 首次上线验证对应 SHA `d64ee3f76bdb24cdfcfed76cbd958a615183feb5`。
- [ ] 真实双设备完成同时编辑、断网、响应丢失、旧页面恢复联网、删除防复活、阅读位置和笔记冲突。
- [x] Admin 生成的一次性 signup/recovery token 已通过真实确认、重置、密码更新、重复使用和无效 token 路由；测试账号已删除。
- [ ] 真实注册／找回邮件投递、PKCE 邮件点击、真正过期 token 及刷新登录状态通过。
- [ ] 三条 Vercel Cron 至少各观察一次自然触发，并完成清理器崩溃、租约到期和可重试 Storage 故障。
- [ ] staging 备份在新隔离项目恢复成功，并从零跑完 27 份迁移。
- [ ] 其余 staging 闸门关闭后，重新冻结最终候选 Git SHA、Vercel Deployment ID、不可变部署地址和数据库迁移上界。
- [ ] 实时核对生产迁移历史、Supabase 方案、备份状态、Security Advisor、Auth URL 和 Redirect URLs。
- [ ] 生产变量差异逐项审核；Preview 不复用生产服务端密钥。
- [ ] 明确维护窗口、停写方式、负责人、回退判断和用户通知方式。

## 生产维护窗口

执行者应逐项记录开始时间、结果和证据，不把多步操作合并成一个“成功”：

1. 冻结写入和后台任务；确认网页不再接受会产生新 revision、上传或 AI 任务的操作。
2. 生成最终数据库与 Storage 备份，并完成可读性检查。
3. 记录生产迁移历史、关键表计数、Storage 对象数和待处理队列数量。
4. 按文件名顺序应用缺失迁移；每份失败立即停止，不继续后续迁移。
5. 核对迁移历史为 27 条，并检查 RLS、函数授权、Storage policy 和调度依赖。
6. 配置经过审核的 Vercel Production 变量和生产 Auth URL／Redirect URLs。
7. 配置资料整理分钟调度；其密钥与 `CONUO_PROCESSOR_SECRET` 匹配。
8. 配置三条 Vercel Cron；`CRON_SECRET` 与路由实际采用的清理密钥匹配。
9. 从已验收 SHA 晋升生产部署，等待 Ready 后再解除停写。
10. 使用专用生产冒烟账号验证登录、上传、刷新、问答、整理、冲突 409 和删除队列；不使用用户真实资料做破坏性测试。
11. 观察错误日志、数据库连接、任务积压和模型用量；达到回退条件立即停止放量。

## 回退与前向修复

代码回退和数据库回退是两件事：

- Vercel 可以把别名重新指向上一份已知可用部署，但旧代码必须兼容已经应用的新 schema。
- 已应用的数据库迁移不通过改写旧文件或手工删除迁移记录回退。
- 若迁移已提交并产生新数据，优先以前向修复恢复服务；只有恢复演练证明可用、且明确接受恢复点后的数据损失时，才执行整库恢复。
- Storage 删除和 Auth 用户删除属于外部、可能不可逆的操作。进入清理队列后不能用普通数据库回滚假设对象或账号会回来。

建议回退触发条件：认证失败、跨账号可见、保存无法完成、持续 5xx、冲突请求重新挂起、后台队列无法停止增长、Storage 原件不可读，或删除任务越权／误删。单个模型回答质量问题应先关闭对应 AI 开关或模型入口，不立即恢复整库。

## 发布后观察

至少检查以下信号：

- 登录、工作区 GET／PUT 的状态码和延迟。
- 409 冲突比例与是否存在长时间挂起请求。
- 上传预留状态分布、过期对象和 Storage 物理对象差异。
- 整理、索引、资料清理和账号注销队列的等待、租约、重试和失败数。
- 模型请求完成／失败／取消、每日额度和缓存命中。
- Vercel Cron 的自然调用日志及三个入口的 200／401／5xx。

生产验收完成后，把实际 SHA、Deployment ID、迁移历史、备份恢复证据和残余风险回填到本页与 [staging 部署记录](STAGING_DEPLOYMENT.md)。
