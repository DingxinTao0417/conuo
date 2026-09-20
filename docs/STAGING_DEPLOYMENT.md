# Staging 部署与验收

更新时间：2026-09-20。本文记录真实部署结果，历史开发验收不等于本环境验收。**已部署独立 staging；本轮代码已提交并推送 `main`；未升级原生产环境。**

## 环境与发布来源

| 项目              | 当前值                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| 测试站            | https://conuo-staging.vercel.app                                                                          |
| Vercel 项目       | `dingxintao0417s-projects/conuo-staging`                                                                  |
| Vercel Project ID | `prj_XVdAZjFtRZ6gAqc818JZcIU6hn8M`                                                                        |
| 最近完整验收部署  | `dpl_FP8dbxJujPjrKsxscj2N1QSNkbJc`，Ready                                                                 |
| 对应不可变地址    | https://conuo-staging-hscc19bve-dingxintao0417s-projects.vercel.app                                       |
| Supabase 项目     | `conuo-staging` / `yyleaedclbhsiowsaunt`                                                                  |
| Supabase 资源     | 独立 Free 项目，us-east-1，Nano；由 Vercel Marketplace 管理                                               |
| Web 运行时        | Next.js，Node 24.x；Root Directory 为 `apps/web`，允许读取工作区根文件                                    |
| 数据库迁移        | 原 24 份从空项目顺序执行，随后追加 25—27 三份修复；历史表实际为 27 条                                     |
| 发布来源          | GitHub `DingxinTao0417/conuo` 的 `main`；Vercel 已连接仓库，后续 push 自动创建部署                        |
| 原生产环境        | `conuo` Vercel 项目及 `czcurayfzshrqievceww` Supabase 未修改；原站已有 Ready 部署，不能再表述为从未部署过 |

这里使用独立 Vercel 项目的 Production target，使该项目的 Cron 可以执行；它仍是测试环境，不是原生产站上线。首次部署来自 Git 忽略的隔离快照，随后同一内容已固化到 Git，Vercel 项目已连接 GitHub 仓库。生产数据库最后一次记录为 19 份迁移，本轮没有重新核验或更改它。相对当前仓库的 27 份，预期需要补八份，但生产执行前必须再次实时核对。

## 配置与隔离

- Vercel staging Production 已配置 16 个变量：staging Supabase 公钥与服务端 secret、现有模型配置、独立 processor/cleanup 密钥及发布开关。服务端 secret 不进入浏览器。
- `NEXT_PUBLIC_CONUO_ORGANIZATION_PROCESSOR_ENABLED=true`，`NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED=false`；在确认调度端点实际返回 200 后重新构建。
- 模型配置沿用现有 DeepSeek，每账号每日生成额度为 10。没有配置独立 Embedding 模型；本次不证明语义索引可用，也没有部署 Python 索引处理器。
- Auth Site URL 为测试站；精确回调包括测试站、`localhost:3000` 和 `127.0.0.1:3000` 的 `/auth/callback` 及 `/auth/callback?next=/auth/reset-password`。邮件发送和找回密码尚未实际验收。
- `apps/web/.env.local` 已切至 staging。切换前的完整文件备份在 Git 忽略的 `work/staging-release/.env.production-before-staging.local`。现有生产账号／资料不会自动复制到 staging；本地需使用 staging 账号重新登录。完成时未运行本地 3000 服务。
- `originals` 是私有桶；核对时面向业务的 public 表未启用 RLS 的数量为 0。QA 用 A/B 两个独立账号，仅含本轮自行编写的验收资料。

凭据与 QA 密码只保存在被 Git 忽略的本机配置及相应云平台，不写入本文。`work/staging-release` 含配置、登录测试文件和部署快照，不应整体分享或提交。

## 调度

| 任务           | 实际调度                                                                             | 已观察证据                                                                            |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 资料／知识整理 | Supabase `pg_cron` 每分钟，通过 `pg_net` POST `/api/internal/organization-processor` | job 1 / `conuo-staging-organization` 为 active；多次 HTTP 200；有真实模型任务发布成功 |
| 资料原件清理   | Vercel `17 3 * * *` UTC                                                              | 已注册；从控制台 Run 后日志 HTTP 200                                                  |
| 上传预留清理   | Vercel `20 3 * * *` UTC                                                              | 已注册；从控制台 Run 后日志 HTTP 200                                                  |
| 账号注销清理   | Vercel `22 3 * * *` UTC                                                              | 已注册；从控制台 Run 后日志 HTTP 200                                                  |

Vercel Hobby 的 daily Cron 有一小时调度窗口。三条清理任务已验证注册及平台手动触发，尚未等到下一次自然定时触发，也未完成有数据的删除生命周期验收。不能把空队列 200 写成“原件已物理删除”或“账号注销已验收”。

Vercel 以 `CRON_SECRET` 发送 Bearer；本环境 `CONUO_CLEANUP_SECRET` 与其相同。整理 processor 使用另一把 `CONUO_PROCESSOR_SECRET`，存于 Supabase Vault 的 `conuo_staging_processor_secret`。运维 SQL 在 [staging-organization-cron.sql](../supabase/operations/staging-organization-cron.sql)，不是 schema migration，不能随迁移复制到生产。

分钟调度每次最多领取 1 个任务，租约 120 秒，HTTP 超时 65 秒。成功的 cron SQL 仅代表 HTTP 已排队，应同时查看 `net._http_response` 和任务状态。暂停时先核实 job 名称／ID，再使用脚本注释中的 `cron.alter_job`；恢复时重新确认端点和凭据。三条 Vercel Cron 可在 staging 的 Cron Jobs 设置暂停。本轮为后续验收保留这些调度运行，没有启用付费套餐。

## 实际验收

| 场景               | 结果与边界                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 登录与刷新         | staging QA A 从网页登录成功，刷新可读云端资料；A 的第二个独立 API 会话可读取相同数据                                                                                                  |
| Storage 与账号隔离 | A 上传／下载原件 SHA-256 一致；B 下载 A 路径失败、查询 A 工作区返回 0 行，B 仍无工作区                                                                                                |
| 浏览器导入         | 文件选择器上传 348 字节自编 TXT，完成预留、ArrayBuffer 直传、保存和解析；刷新后仍有正文和 2 个内容块，下载哈希一致                                                                    |
| 并发 CAS           | 同 revision 的两个会话保存分别返回 200（300ms）和 409（608ms）；旧 revision 重试 270ms 返回 409；只有成功请求推进 revision                                                            |
| 后台 AI 整理       | 任务 `50379a58-46a5-4625-8fca-9cad66a01ce7` 于 09:15:46 UTC 入队，由分钟调度自动处理，09:16:02.711 UTC 成为 `ready`，`mode=model`，1 条摘要引用、7 个标签、4 个主题；账本 `completed` |
| 内部入口鉴权       | processor 与三个 cleanup 无密钥 401、正确密钥 200；三个 cleanup 另有 Vercel 控制台 Run 的真实 200 日志                                                                                |
| 业务冲突响应       | 第 27 份迁移将 49 个显式业务 `40001` 改为 `PT409`，迁移后旧码为 0；整理取消、资料／历史版本清理、解析完成／取消／重试均在真实接口快速返回 409，且陈旧请求没有写入                     |
| 本地回归与构建     | 全量 243 个测试文件／4,172 项通过；包含从零重放全部 27 份迁移的 PGlite 测试。TypeScript、格式检查、本地及 Vercel 构建通过；ESLint 0 错误，保留已有 `_result` 警告                     |

本机证据文件：`work/staging-release/final-smoke-results.json`、`concurrency-results.json`、`endpoint-results.json`、`conflict-smoke.mjs`。它们位于 Git 忽略目录，是本轮现场记录，不是可替代后续验收的永久保证。当前保留 A/B 两个 QA 账号和一个专用的可丢弃冲突／生命周期账号，供继续验证；没有导入用户真实旧资料。临时错误探针函数已移除。

## 本次发现并修复

1. **真实 Storage 预检拒绝上传。** 平台上传权限预检传入 `metadata.contentLength`，原 policy 只读 `size`。第 25 份 [迁移](../supabase/migrations/20260920000100_storage_upload_preflight.sql) 兼容该字段，同时维持 owner、精确路径、活预留与字节数相等检查。有 `size` 时必须严格检查，不能用备用字段绕过。浏览器改为上传原始 ArrayBuffer；完成 RPC 继续核对实际对象大小。
2. **工作区冲突超时。** staging 上单独抛出 `40001` 的无业务写入探针也超时；分别调用 `PT409`、`22023` 和成功路径迅速返回。第 26 份 [迁移](../supabase/migrations/20260920000200_workspace_conflict_response.sql) 在 `save_workspace` 边界将 serialization failure 转成 `PT409`，保留完整事务回滚、CAS、锁和依赖防复活保护；Web 同时兼容新旧错误码。云端内部为何挂起尚未证实，不能断言某层自动重试是根因。
3. **其余业务冲突超时。** 第 27 份 [迁移](../supabase/migrations/20260920000300_business_conflict_response.sql) 审计并改写 `public` 与 `conuo_private` 中 49 个显式业务 `40001`；迁移后旧码为 0，函数 OID、签名及授权保持不变，真正的 PostgreSQL serialization failure 语义不受影响。真实 staging 使用陈旧 revision 验证整理取消、资料彻底删除、历史版本清理、解析完成、解析取消和解析重试，分别在 250—294ms 量级返回对应 409；请求前后 revision 与内容核对证明没有误写。
4. **Cron 配置位置。** Vercel Root Directory 为 `apps/web`，配置已移到 [apps/web/vercel.json](../apps/web/vercel.json)，这次实际注册了三个清理任务。

仓库与 staging 的显式业务冲突已统一为 `PT409`；Web 在滚动迁移期间仍兼容旧 `40001`。本轮真实接口覆盖上述六条用户可见主路径，数据库完整迁移链另保证 49 个旧业务码全部归零。真双设备中的解析租约竞争、网络中断和迟到结果仍属于下一轮行为验收，不能由陈旧 revision 探针替代。

## 下一轮验收与生产门槛

- 使用两台真实设备测试同步、离线恢复、并发编辑、解析租约与迟到结果；当前两个 API 会话不等同于真双设备。
- 覆盖额度耗尽、重复请求、缓存过期、任务超时恢复，以及有数据的清理／账号注销；仅使用明确可丢弃的 QA 数据。
- 验证注册邮件、PKCE 回调及找回密码。若要开启语义检索，另配 Embedding 并部署索引处理器。
- 本轮代码已提交并推送 `main`；生产发布仍是独立阶段，必须以已验收提交为来源，不能直接复用旧部署快照。
- 生产前先实时核对原项目迁移历史、做好并验证数据库及原件备份，再审查增量迁移、环境变量、Auth 回调和独立调度。验收通过后再授权生产升级；本轮未执行这一步。
