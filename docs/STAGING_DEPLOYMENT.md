# Staging 部署与验收

更新时间：2026-09-21。本文记录真实部署结果，历史开发验收不等于本环境验收。**已部署独立 staging；staging 已改为跟随 GitHub `staging` 分支；原生产 Vercel 保持 `main`，Production Preview 自动部署已关闭。原生产数据库未升级。**

## 环境与发布来源

| 项目              | 当前值                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| 测试站            | https://conuo-staging.vercel.app                                                                          |
| Vercel 项目       | `dingxintao0417s-projects/conuo-staging`                                                                  |
| Vercel Project ID | `prj_XVdAZjFtRZ6gAqc818JZcIU6hn8M`                                                                        |
| 最近完整验收部署  | `dpl_9GAVHE5U2b3jq5WLTK8TpDQgQdhq`，Ready，Git 自动部署                                                   |
| 对应不可变地址    | https://conuo-staging-npo01mm1s-dingxintao0417s-projects.vercel.app                                       |
| 当前域名版本      | 以 https://conuo-staging.vercel.app/api/health 返回的分支和完整提交 SHA 为准                              |
| Supabase 项目     | `conuo-staging` / `yyleaedclbhsiowsaunt`                                                                  |
| Supabase 资源     | 独立 Free 项目，us-east-1，Nano；由 Vercel Marketplace 管理                                               |
| Web 运行时        | Next.js，Node 24.x；Root Directory 为 `apps/web`，允许读取工作区根文件                                    |
| 数据库迁移        | 原 24 份从空项目顺序执行，随后追加 25—27 三份修复；历史表实际为 27 条                                     |
| 发布来源          | GitHub `DingxinTao0417/conuo` 的 `staging`；Vercel 已连接仓库，push 自动创建 Production 部署              |
| 原生产环境        | `conuo` Vercel 项目及 `czcurayfzshrqievceww` Supabase 未修改；原站已有 Ready 部署，不能再表述为从未部署过 |

这里使用独立 Vercel 项目的 Production target，使该项目的 Cron 可以执行；它仍是测试环境，不是原生产站上线。首次部署来自 Git 忽略的隔离快照，随后同一内容已固化到 Git。2026-09-20 已创建并推送 `staging` 分支，staging 的 Production Branch 已切换为 `staging`，并以提交 `5f6b50ff99ae558cf2738a053dea79fb2fcfe77a` 触发 Git 自动部署；部署状态为 Ready。该提交和上表 Deployment ID 是完整验收基线，不代表可变域名永远停留在该版本。提交 `d64ee3f76bdb24cdfcfed76cbd958a615183feb5` 增加无缓存的 `/api/health` 发布探针，首次真实请求返回 `environment=production`、`branch=staging` 和同一完整 SHA；后续以该端点实时返回值确认当前域名版本。原生产项目仍跟随 `main`，但已关闭 Preview 自动部署，避免 staging 分支在生产项目生成带生产变量的预览。生产数据库最后一次记录为 19 份迁移，本轮没有重新核验或更改它。相对当前仓库的 27 份，预期需要补八份，但生产执行前必须再次实时核对。

本轮只读核对确认，`conuo` 生产项目仍连接 `main`，`conuo-staging` 已连接同一仓库的 `staging`。原生产项目的 Preview 自动部署已关闭；生产网页仍可能与 19 份数据库迁移不一致，发布处置见[生产发布手册](PRODUCTION_RELEASE.md)。

## 配置与隔离

- Vercel staging Production 已配置 16 个变量：staging Supabase 公钥与服务端 secret、现有模型配置、独立 processor/cleanup 密钥及发布开关。服务端 secret 不进入浏览器。
- `NEXT_PUBLIC_CONUO_ORGANIZATION_PROCESSOR_ENABLED=true`，`NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED=false`；在确认调度端点实际返回 200 后重新构建。
- 模型配置沿用现有 DeepSeek，每账号每日生成额度为 10。没有配置独立 Embedding 模型；本次不证明语义索引可用，也没有部署 Python 索引处理器。
- Auth Site URL 为测试站；精确回调包括测试站、`localhost:3000` 和 `127.0.0.1:3000` 的 `/auth/callback` 及 `/auth/callback?next=/auth/reset-password`。Admin 生成的一次性 signup/recovery token 已通过真实确认与密码更新路由；另一个 signup token 在真实等待超过配置有效期后进入安全错误页。受控邮箱的真实注册确认邮件与同浏览器 PKCE 回调也已通过。Chrome／Edge 的一小时持久会话已在浏览器重启后自动轮换 Cookie、推进到期时间并保持工作区 200。`2026-09-20T17:08:51Z` 又向受控账号发起真实找回请求，Auth 返回 200，并于 `17:08:52Z` 更新服务端 `recovery_sent_at`。该请求由无浏览器脚本发起，没有正式 Web 客户端的 PKCE verifier，因此当时只能证明 Auth 接受并进入邮件生成流程；同浏览器完整链路已由项目所有者在后续人工验收中确认通过，见下方记录。
- `apps/web/.env.local` 已切至 staging。切换前的完整文件备份在 Git 忽略的 `work/staging-release/.env.production-before-staging.local`。现有生产账号／资料不会自动复制到 staging；本地需使用 staging 账号重新登录。完成时未运行本地 3000 服务。
- `originals` 是私有桶；核对时面向业务的 public 表未启用 RLS 的数量为 0。QA 用 A/B 两个独立账号，仅含本轮自行编写的验收资料。
- 项目所有者于 `2026-09-21` 确认已使用两台真实设备完成同步矩阵，并从 Conuo 登录页发起真实找回密码邮件、在同一浏览器完成回调和密码重置，两项均无异常。这两项依据用户验收记录，不保存设备标识、邮件、密码、token 或完整网络日志；跨浏览器邮件点击仍未验收。

凭据与 QA 密码只保存在被 Git 忽略的本机配置及相应云平台，不写入本文。`work/staging-release` 含配置、登录测试文件和部署快照，不应整体分享或提交。

## 调度

| 任务           | 实际调度                                                                             | 已观察证据                                                                            |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 资料／知识整理 | Supabase `pg_cron` 每分钟，通过 `pg_net` POST `/api/internal/organization-processor` | job 1 / `conuo-staging-organization` 为 active；多次 HTTP 200；有真实模型任务发布成功 |
| 资料原件清理   | Vercel `17 3 * * *` UTC                                                              | 已注册；手动 200；自然调度后的待清理原件已物理消失                                    |
| 上传预留清理   | Vercel `20 3 * * *` UTC                                                              | 已注册；手动 200；自然调度后的过期预留原件已物理消失                                  |
| 账号注销清理   | Vercel `22 3 * * *` UTC                                                              | 已注册；手动 200；自然调度后的 Storage 与 Auth 删除均完成                             |

Vercel Hobby 的 daily Cron 有一小时调度窗口。三条清理任务已验证注册及平台手动触发；另通过受保护清理入口完成孤立上传、带数据的历史版本、资料和账号删除生命周期，确认 Storage 原件物理消失及 Auth 用户删除。

`2026-09-21T05:06:34Z` 在未手工调用任何 cleanup API 的前提下完成自然调度终态核对。资料原件和过期上传预留的 Storage 对象均已消失，两个保留用于观察的普通 QA 账号仍存在；账号注销样本的 Storage 对象和 Auth 用户均已消失。核对时可变域名 `/api/health` 返回 `production`、`staging` 和提交 `86bf9ba298bb8a2f5bcd7787987e871a2216122d`。这证明三条 daily Cron 在 Hobby 调度窗口内达到预期终态；崩溃后的过期租约重领与可重试故障仍在独立韧性阶段等待自然调度，不能提前写成通过。

`2026-09-21T06:08:11.768Z`，独立韧性样本在预留自然过期后完成 `reserved → staged`：仅通过 staging RPC 留置一个 30 秒租约，并将另一份样本记录为可重试失败，未调用 cleanup API。阶段完成后 `/api/health` 核对到 `staging` 提交 `cc381e51b83aa13b4b806e46ed330a4a157312de`。最早终态核对时间为 `2026-09-22T04:30:00Z`；两份样本保留等待下一次自然 Cron。此次仅确认故障状态准备成功，过期租约重领与失败重试恢复尚未通过。

Vercel 以 `CRON_SECRET` 发送 Bearer；本环境 `CONUO_CLEANUP_SECRET` 与其相同。整理 processor 使用另一把 `CONUO_PROCESSOR_SECRET`，存于 Supabase Vault 的 `conuo_staging_processor_secret`。运维 SQL 在 [staging-organization-cron.sql](../supabase/operations/staging-organization-cron.sql)，不是 schema migration，不能随迁移复制到生产。

分钟调度每次最多领取 1 个任务，租约 120 秒，HTTP 超时 65 秒。成功的 cron SQL 仅代表 HTTP 已排队，应同时查看 `net._http_response` 和任务状态。暂停时先核实 job 名称／ID，再使用脚本注释中的 `cron.alter_job`；恢复时重新确认端点和凭据。三条 Vercel Cron 可在 staging 的 Cron Jobs 设置暂停。本轮为后续验收保留这些调度运行，没有启用付费套餐。

## 实际验收

| 场景               | 结果与边界                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 登录与刷新         | staging QA A 从网页登录成功，刷新可读云端资料；A 的第二个独立 API 会话可读取相同数据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Storage 与账号隔离 | A 上传／下载原件 SHA-256 一致；B 下载 A 路径失败、查询 A 工作区返回 0 行，B 仍无工作区                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 浏览器导入         | 文件选择器上传 348 字节自编 TXT，完成预留、ArrayBuffer 直传、保存和解析；刷新后仍有正文和 2 个内容块，下载哈希一致                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 并发 CAS           | 同 revision 的两个会话保存分别返回 200（300ms）和 409（608ms）；旧 revision 重试 270ms 返回 409；只有成功请求推进 revision                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 双浏览器同步       | 同一主机的独立 Chrome／Edge 进程从相同 revision 同时保存，准确得到一次 200 和一次 409；断网编辑在页面保留，重连后保存并刷新恢复；服务端已提交但响应被截断时，通过权威回读确认成功且没有重复提交                                                                                                                                                                                                                                                                                                                                                                              |
| 冲突与防复活       | 独立 Chrome／Edge 已完成资料离线改名与另一端软删除竞态，删除状态胜出且旧端不能把资料恢复为有效内容；笔记同时编辑进入专用冲突对照，手工合并后正文包含双方修改，两个落选版本均保留在历史                                                                                                                                                                                                                                                                                                                                                                                       |
| 阅读位置冲突       | 自编长 TXT 在独立 Chrome／Edge 从相同位置同时滚动，得到 200／409；失败端选择当前页面位置后保存 200，云端保留落选位置；从“已保留阅读位置”切换后再次保存 200，原当前位置也继续可恢复                                                                                                                                                                                                                                                                                                                                                                                           |
| 后台 AI 整理       | 任务 `50379a58-46a5-4625-8fca-9cad66a01ce7` 于 09:15:46 UTC 入队，由分钟调度自动处理，09:16:02.711 UTC 成为 `ready`，`mode=model`，1 条摘要引用、7 个标签、4 个主题；账本 `completed`                                                                                                                                                                                                                                                                                                                                                                                        |
| 内部入口鉴权       | processor 与三个 cleanup 无密钥 401、正确密钥 200；三个 cleanup 另有 Vercel 控制台 Run 的真实 200 日志                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 业务冲突响应       | 第 27 份迁移将 49 个显式业务 `40001` 改为 `PT409`，迁移后旧码为 0；整理取消、资料／历史版本清理、解析完成／取消／重试均在真实接口快速返回 409，且陈旧请求没有写入                                                                                                                                                                                                                                                                                                                                                                                                            |
| 孤立上传清理       | 分别构造 Storage 上传成功但未确认的 `reserved` 状态，以及上传确认成功但未提交工作区的 `uploaded` 状态；两者自然等待 15 分钟预留期后由正式 cleanup 一次领取 2 个、完成 2 个，Storage 对象均物理消失，无重试或失败                                                                                                                                                                                                                                                                                                                                                             |
| 删除生命周期       | 历史版本和资料清理各领取并完成 1 个任务，Storage 原件均物理消失；资料删除选择了 2 个笔记版本、1 段对话和 2 条消息，旧快照复活返回 409；账号预览含 1 份资料、1 个版本和 1 个对象，注销后工作区返回 423，Storage 与 Auth 两阶段均完成                                                                                                                                                                                                                                                                                                                                          |
| Auth token 流程    | Admin 生成的一次性 signup token 在真实 `/auth/confirm` 建立会话，空工作区读取 200；recovery token 打开重置页并成功更新密码，旧密码被拒、新密码可登录；重复使用 signup/recovery token 及无效 token 均进入 `/auth/error`。另一 signup token 从 `2026-09-20T15:45:33Z` 等待至有效期后，在 `16:50:44Z` 进入 `/auth/error` 且未建立会话。受控邮箱另完成真实注册：`/signup` 200 并记录确认请求，邮件链接 `/verify` 303，随后 PKCE `/token` 200 建立会话。无浏览器找回请求已获 200 且 `recovery_sent_at` 随后更新，但没有正式客户端 PKCE verifier；收件、应用回调与密码更新仍待验收 |
| Auth 会话刷新      | Chrome 与 Edge 分别保留独立真实会话超过一小时；浏览器重启后播种 Cookie 指纹一致，随后均自动轮换 Cookie、推进到期时间，工作区请求返回 200。专用账号与两个 Profile 已删除                                                                                                                                                                                                                                                                                                                                                                                                      |
| 本地回归与构建     | 全量 243 个测试文件／4,172 项通过；包含从零重放全部 27 份迁移的 PGlite 测试。TypeScript、格式检查、本地及 Vercel 构建通过；ESLint 0 错误，保留已有 `_result` 警告                                                                                                                                                                                                                                                                                                                                                                                                            |
| Git 发布复现       | 推送 `staging` 后自动创建部署 `dpl_9GAVHE5U2b3jq5WLTK8TpDQgQdhq`，状态 Ready；部署元数据中的 ref 为 `staging`、SHA 为 `5f6b50ff99ae558cf2738a053dea79fb2fcfe77a`                                                                                                                                                                                                                                                                                                                                                                                                             |
| 发布版本探针       | 当前域名的 `/api/health` 无缓存返回 Vercel 运行时环境、Git 分支和完整 SHA；首次上线验证返回 `production`、`staging`、`d64ee3f76bdb24cdfcfed76cbd958a615183feb5`                                                                                                                                                                                                                                                                                                                                                                                                              |
| 其余业务冲突       | 在上述部署重新实测解析完成／取消／重试陈旧请求，分别返回 409，耗时 303／297／274ms；最终资料为 `saved`、任务为 `cancelled`，没有迟到写入                                                                                                                                                                                                                                                                                                                                                                                                                                     |

本机证据文件：`work/staging-release/final-smoke-results.json`、`concurrency-results.json`、`endpoint-results.json`、`conflict-smoke.mjs`、`deletion-lifecycle-results.json`、`orphan-upload-lifecycle-results.json`、`browser-offline-response-loss-results.json`、`two-browser-workspace-conflict-results.json`、`two-browser-delete-no-revival-results.json`、`two-browser-note-conflict-results.json`、`two-browser-reading-position-results.json`、`auth-email-registration-results.json`、`auth-refresh-results.json`。它们位于 Git 忽略目录，是本轮现场记录，不是可替代后续验收的永久保证；邮件与刷新证据只保留时间、浏览器代号、布尔断言和 HTTP 状态，不含邮箱、用户 ID、IP、cookie、token 或请求 ID。专用冲突／生命周期、孤立上传和会话刷新账号均已完成验证并删除；当前只保留 A/B 两个 QA 账号、受控邮件验收账号及供物理设备复核的自编长 TXT。没有导入用户真实旧资料，临时错误探针函数已移除。

## 本次发现并修复

1. **真实 Storage 预检拒绝上传。** 平台上传权限预检传入 `metadata.contentLength`，原 policy 只读 `size`。第 25 份 [迁移](../supabase/migrations/20260920000100_storage_upload_preflight.sql) 兼容该字段，同时维持 owner、精确路径、活预留与字节数相等检查。有 `size` 时必须严格检查，不能用备用字段绕过。浏览器改为上传原始 ArrayBuffer；完成 RPC 继续核对实际对象大小。
2. **工作区冲突超时。** staging 上单独抛出 `40001` 的无业务写入探针也超时；分别调用 `PT409`、`22023` 和成功路径迅速返回。第 26 份 [迁移](../supabase/migrations/20260920000200_workspace_conflict_response.sql) 在 `save_workspace` 边界将 serialization failure 转成 `PT409`，保留完整事务回滚、CAS、锁和依赖防复活保护；Web 同时兼容新旧错误码。云端内部为何挂起尚未证实，不能断言某层自动重试是根因。
3. **其余业务冲突超时。** 第 27 份 [迁移](../supabase/migrations/20260920000300_business_conflict_response.sql) 审计并改写 `public` 与 `conuo_private` 中 49 个显式业务 `40001`；迁移后旧码为 0，函数 OID、签名及授权保持不变，真正的 PostgreSQL serialization failure 语义不受影响。真实 staging 使用陈旧 revision 验证整理取消、资料彻底删除、历史版本清理、解析完成、解析取消和解析重试，均在 10 秒界限内快速返回对应 409；最新部署复验的三条解析路径耗时 274—303ms。请求前后 revision 与内容核对证明没有误写。
4. **Cron 配置位置。** Vercel Root Directory 为 `apps/web`，配置已移到 [apps/web/vercel.json](../apps/web/vercel.json)，这次实际注册了三个清理任务。

仓库与 staging 的显式业务冲突已统一为 `PT409`；Web 在滚动迁移期间仍兼容旧 `40001`。本轮真实接口覆盖上述六条用户可见主路径，数据库完整迁移链另保证 49 个旧业务码全部归零。项目所有者随后确认两台真实设备同步矩阵无异常；解析租约竞争和迟到解析结果仍由独立云端验收覆盖，不能由陈旧 revision 探针或用户同步验收替代。

## 下一轮验收与生产门槛

- 同一主机上的独立 Chrome／Edge 已覆盖同时保存、断网重连、提交后响应丢失、旧页面删除防复活、笔记冲突合并和阅读位置选择／回切；项目所有者于 `2026-09-21` 确认两台真实设备同步矩阵同样无异常。解析租约与迟到解析结果仍需由独立任务证据覆盖。
- 覆盖额度耗尽、重复请求、缓存过期、任务超时恢复及清理任务崩溃／重试；仅使用明确可丢弃的 QA 数据。
- 项目所有者于 `2026-09-21` 确认已从 Conuo 登录页发起真实找回密码邮件，并在同一浏览器完成链接点击、回调和密码重置。跨浏览器 token-hash 模板仍未配置或验收；staging 未启用自定义 SMTP，默认模板仍使用 `{{ .ConfirmationURL }}`。真实等待后的过期 signup token、注册确认邮件、同浏览器 PKCE 和 Chrome／Edge 持久会话自动刷新也已通过。若要开启语义检索，另配 Embedding 并部署索引处理器。
- 本轮代码已提交并推送 `staging`；生产发布仍是独立阶段，必须以已验收提交为来源，不能直接复用旧部署快照。
- 生产前先实时核对原项目迁移历史、做好并验证数据库及原件备份，再审查增量迁移、环境变量、Auth 回调和独立调度。验收通过后再授权生产升级；本轮未执行这一步。

staging Supabase 当前为 Free 方案，控制台明确显示不包含计划备份，`Restore to a new project` 也要求 Pro 及物理备份。用户已明确不在本机安装 PostgreSQL，因此生产演练只采用 Supabase 托管恢复路径：获得单独授权后升级方案，等待并确认实际物理备份可用，再恢复到新的隔离项目。
