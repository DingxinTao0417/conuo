# Conuo 云端开发配置

当前 Web 采用 Supabase Auth、PostgreSQL 和私有 Storage，云端是唯一正式存储。必须配置项目并登录才能打开工作台；未配置或未登录时不创建匿名工作区。浏览器内存只暂存编辑与待上传原件，刷新后重新读取云端。本地与云端共存留给未来桌面版，当前边界见 [Web 存储政策](WEB_CLOUD_STORAGE.md)。本文不包含项目凭据，也不以迁移源文件作为环境已部署完成的证据。

## 当前环境（2026-09-20）

2026-09-20 已创建独立 staging：27 份迁移已应用，Web 已部署到 https://conuo-staging.vercel.app，分钟级整理调度及三条清理 Cron 已配置。上传、跨账号隔离、双会话 CAS、真实模型后台整理、主要业务冲突接口、孤立上传清理、带数据删除／注销主链路、真实注册确认邮件及同浏览器 PKCE 已通过；真双设备、断网、自然 Cron、真实找回密码邮件、跨浏览器邮件、过期 token 与刷新会话仍待验收。staging 现从 GitHub `staging` 分支自动部署，原生产 Vercel 保持 `main` 且已关闭 Preview 自动部署；原生产数据库未升级，发布前仍需处理代码与 schema 漂移。本轮修复已提交并推送 `staging`，Git 自动部署已用完整验收基线 SHA `5f6b50ff99ae558cf2738a053dea79fb2fcfe77a` 验证；当前可变域名的实际分支和完整 SHA 以无缓存的 `/api/health` 返回为准。详细证据见 [Staging 部署与验收](STAGING_DEPLOYMENT.md)和[生产发布手册](PRODUCTION_RELEASE.md)。本机开发配置现已指向 staging，原生产配置备份在被 Git 忽略的 `work/staging-release/.env.production-before-staging.local`。

## 本地配置

1. 在你用于开发的 Supabase 项目中，确认启用 Email/Password 登录；建议保留邮箱确认。
2. 在独立开发项目备份并核对扩展/同名对象后，按以下顺序维护迁移；将新项目升级到当前代码时按顺序应用 `supabase/migrations/`：
   1. `202609120001_workspace_foundation.sql`：工作区、revision 保存协议和私有 `originals` 桶。
   2. `202609120002_ai_requests.sql`：生成式问答和整理的请求账本。
   3. `202609120003_source_retrieval.sql`：规范化资料/版本/内容块、pgvector、索引租约和字符预算，并回填已有工作区。
   4. `202609120004_source_purge.sql`：资料彻底删除协议、tombstone 和 Storage cleanup outbox。
   5. `202609120005_source_purge_cleanup.sql`：资料 outbox 的 service-role 租约、退避和完成确认。
   6. `202609120006_account_deletion.sql`：账号注销的 Storage/Auth 两阶段 outbox、访问封锁和迟到对象重开。
   7. `202609120007_account_deletion_embedding_fence.sql`：注销时取消向量任务、清空模型结果，并阻止迟到的模型/向量任务写回。
   8. `202609130001_document_notes_evidence.sql`：资料彻底删除时保留 document-notes 个人笔记证据的历史快照，移除原资料引用，并阻止它作为新的单资料提问范围。
   9. `202609130002_answer_attempts.sql`：在资料彻底删除后保留问答尝试的范围快照，并将受影响尝试标记为 `source-purged`，避免自动重试已删除资料。
   10. `202609130003_manual_excerpt_references.sql`：资料彻底删除时，从当前及历史笔记移除手工摘录引用中的资料标识。
   11. `20260913222422_normalized_notes_projection.sql`：把 `workspaces.data.notes` 投影到 `notes` 和 `note_versions` 的事务性读层；浏览器仍只写工作区 JSONB 快照。
   12. `20260913233000_import_parse_leases.sql`：同一账号跨设备导入时的资料版本解析租约、心跳、令牌围栏、原子完成/取消/重试；**已在连接的开发 Supabase 项目执行并完成 SQL/RLS 核验；真实两设备联调仍待进行。**
   13. `20260914000100_normalized_conversations_projection.sql`：把 `workspaces.data.conversations` 投影到 `conversations` 和 `conversation_messages` 的事务性只读层，保留消息顺序、引用、笔记证据和回答尝试；**已在连接的开发 Supabase 项目执行并完成结构、RLS、权限、policy 与触发器核验。**
   14. `20260914000200_normalized_annotations_projection.sql`：把版本绑定的 `workspaces.data.annotations` 投影到账号隔离的 `annotations` 只读表；**已在连接的开发 Supabase 项目执行并完成结构、RLS、权限、policy 与触发器核验。**
   15. `20260914000300_normalized_concept_relations_projection.sql`：把 `workspaces.data.conceptRelations` 投影到账号隔离的 `concept_relations` 只读表，保留关系类型、双页知识快照、证据、来源、revision 与软删除状态；**已在连接的开发 Supabase 项目执行并完成结构、RLS、权限、policy 与触发器核验。**
   16. `20260914000400_normalized_learning_spaces_projection.sql`：把 `workspaces.data.spaces` 投影到账号隔离的 `learning_spaces` 只读表，保留知识库书架顺序、名称、目标、颜色、归档状态与创建身份；**已在连接的开发 Supabase 项目执行并完成结构、RLS、权限、policy 与触发器核验。**
   17. `20260914000500_source_version_purge.sql`：历史资料版本的服务端影响预览、CAS 清理事务和版本级 Storage outbox；复用既有资料清理 worker，**已在连接的开发 Supabase 项目执行；`source_purges` 的两个新字段、两个 RPC 及仅 `authenticated` 可执行的权限边界已核验。**
   18. `20260914000600_fix_project_workspace_space_alias.sql`：修复资料库投影读取 JSON 数组元素时的值列访问。
   19. `20260914000700_fix_project_workspace_space_alias_scope.sql`：为两个资料库 JSON 数组结果集显式声明 `sp(value)`，修复历史云端定义遗漏聚合子查询别名的问题；**已在连接项目执行，并以真实账号的笔记保存复测。**
   20. `20260914000800_fast_workspace_saves.sql`：缩短忙写路径并跳过未变化的读投影；**已应用独立 staging；原生产未应用。**
   21. `20260914120601_upload_intents.sql`：原件上传预留、服务端精确配额、Storage INSERT 收紧、工作区 CAS 内提交和过期原件清理租约；**已应用独立 staging；原生产未应用。**
   22. `20260914120700_organization_jobs.sql`：资料／知识整理的持久任务、租约与结果提交；**已应用独立 staging；原生产未应用。**
   23. `20260915045450_annotation_utf16_text_anchors.sql`：批注只读位置投影、精确 UTF-16 原文切片、不可变身份与新锚点恢复草稿核验；**已应用独立 staging；原生产未应用。**
   24. `20260915060323_source_purge_saved_content_selection.sql`：资料彻底删除时按权威预览逐篇选择关联笔记／知识页（含当前及全部历史正文）、逐个选择整段对话；另存内容墓碑、生成依赖清理和相关模型缓存收窄保留额度账行；**已应用独立 staging；原生产未应用。**
   25. `20260920000100_storage_upload_preflight.sql`：兼容 Storage 上传预检 `contentLength`，保留实际大小与活预留校验；**已应用 staging。**
   26. `20260920000200_workspace_conflict_response.sql`：工作区保存冲突转换为 PostgREST `PT409`，保留事务回滚和 CAS；**已应用 staging。**
   27. `20260920000300_business_conflict_response.sql`：将数据库函数中 49 个显式业务 `40001` 转换为 PostgREST `PT409`，避免过期 revision、租约或状态冲突在托管链路中长时间挂起；**已应用 staging，并完成六条真实接口冲突验收。**

   003 使用 `extensions` schema 下的 `vector` 扩展。托管 Supabase 的 `storage.objects` 由平台角色 `supabase_storage_admin` 拥有，且平台已启用该表的 RLS；006 只维护其 Storage policy，不能对这个平台表执行 `ALTER TABLE` 或改变其所有者。其 restrictive policy 仍会在账号注销处理中与其他 Storage policy 共同生效，不会放宽既有的对象访问隔离。旧数据不符合身份或原件路径约束时，迁移会回滚本次改动，保留此前迁移，不静默跳过。不要重写已应用的迁移；成功升级后的回退须另行评审备份恢复或前向修复。详见 [搜索与索引](SEARCH_INDEXING.md)。原生产项目历史记录已完成并核验前 19 份迁移，包含预期表和函数、私有 `originals` 桶、4 条 Storage policy，以及所有面向用户的 `public` 表 RLS。独立 staging 已应用全部 27 份；原生产的增量仍须在备份和验收后另行升级。第 11 份迁移已额外核验：`public.notes` 与 `public.note_versions` 均启用 RLS、两条仅限当前账号读取的 policy、一个 `project_workspace_notes` trigger 均存在；当时 Supabase Security Advisor 为 0 个 error。第 12 份迁移已实际执行，已核验私有 `conuo_private.import_parse_leases` 表启用 RLS、`claim_import_parse` 与 `finish_import_parse` RPC 存在，且 `save_workspace` 带有解析租约保护。第 13—16 份已创建五张只读投影表并登记迁移历史；五张表的 RLS、认证角色只读权限、owner 与账号删除闸门 policy 和四个工作区触发器均已核验。第 17 份迁移已在线核验两个 `source_purges` 字段、两个历史版本清理 RPC 与仅认证用户可执行的权限边界；没有运行任何实际资料版本清理。第 18—19 份修复了资料库 JSON 数组投影的值列与聚合别名；远端函数、迁移记录和真实账号的空资料库笔记保存及刷新重载已核验。第 25—27 份分别修复真实 Storage 上传预检、工作区冲突响应和其余 49 个显式业务冲突响应；迁移源文件仍是开发与恢复依据，其他项目仍须通过自身迁移历史或 schema 核验实际状态。

3. 将 `apps/web/.env.example` 复制为 `apps/web/.env.local`，填入项目 URL 和 publishable key。旧项目的 anon key 也可用于相同公开客户端位置。**`NEXT_PUBLIC_*` 变量中不能填 secret key 或 service_role key。** `.env.local` 已由仓库忽略；不要把密钥发到聊天或提交到 Git。
4. 重启 Web 开发服务器，再通过界面中的账号入口注册或登录。

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

以上变量会进入浏览器构建，属于公开项目连接配置；数据隔离依赖 Auth 与 RLS。部署 Vercel 前需要在目标环境分别配置并重新构建，当前已完成独立 staging 部署，原生产未升级。

### 跨设备导入解析租约（第 12 份迁移已应用）

`20260913233000_import_parse_leases.sql` 为每个账号的 `sourceId + versionId` 在私有 schema 中建立解析租约。登录云端后，浏览器会先认领租约，只有获得精确令牌的设备才下载原件并解析；其他设备保持等待并在租约到期后再尝试。持有者定期心跳，完成结果同时核验令牌和工作区 revision，过期、释放或被替换的令牌都不能提交迟到结果。

同一账号任一设备可以原子取消正在解析的资料版本，取消会使现有租约失效；失败或取消的版本通过受控的原子重试回到解析态。专用完成、取消或重试请求遇到网络结果不确定时，会保留当前页面已确认的状态；重新连接只会在云端 revision 未变化时重放原专用操作，不会把这类状态交给普通工作区保存。刷新后重新读取云端，不依赖本机草稿续接。普通工作区保存仍可修改无关资料，但不能改写受租约保护的资料/任务对，因此不会把另一设备的解析、取消或完成结果覆盖掉。

这些受控转换只能改变解析派生状态，例如正文、内容块、页码解析结果、错误、解析状态和时间；同一资料版本的原件与来源身份（文件哈希、名称、类型、大小、原件键、Storage 路径、网址和网页快照等）必须保持不变。

这些规则已作为第 12 份迁移在连接的开发 Supabase 执行。已核验私有表 RLS、认领与完成 RPC、`save_workspace` 的租约保护；当时原生产迁移历史为 19 条；staging 当前为 27 条。真实 staging 已验证解析完成、取消和重试的陈旧 revision 快速返回 409 且不写入；真实两台设备的认领、心跳、断网与迟到结果拒绝仍待联调，因此不能据此宣称完整跨设备场景已验收。

### 原件上传预留、配额与清理（第 21、25 份迁移，staging 已应用）

`20260914120601_upload_intents.sql` 把一份新原件的云端流程固定为“预留 → 浏览器直传私有 Storage → 服务端确认 → 工作区 revision CAS”。预留记录只关联账号和不可变的资料/版本身份，因此首次创建工作区前也可安全上传。工作区写入的 `BEFORE` trigger 会在同一个事务中确认对应原件；CAS 冲突或任何后续投影失败时，原件保持 `uploaded` 状态，后续同一身份的重试可继续提交，而不会把路径静默写入快照。

该迁移会把 `originals` 的 INSERT policy 收紧为仅允许匹配未过期预留、精确路径和 Storage 元数据大小的请求。账号容量在同一账号锁内按物理 Storage 对象与未完成预留去重计算；本地实现当前沿用每份 30 MiB、每账号 512 MiB 的保守值，但这不是对外存储套餐承诺。已有原件路径会回填为已提交记录，不会因为普通资料元数据保存而被拒绝。

未完成的预留不会由浏览器直接释放：超过租约后，service-role RPC 让 `GET /api/internal/original-upload-cleanup` 领取有限对象批次，删除后才标记为释放；`404` 仍是幂等成功。应用目录 [vercel.json](../apps/web/vercel.json) 已在 staging 注册每天 `03:20 UTC` 的受保护 Cron。该入口复用 `SUPABASE_SECRET_KEY`（或旧版 `SUPABASE_SERVICE_ROLE_KEY`）和至少 32 个可见 ASCII 字符的 `CONUO_CLEANUP_SECRET`（或 Vercel `CRON_SECRET`）。staging 的迁移、变量及 Cron 已部署；真实上传和跨账号隔离通过。已分别验证上传后未确认的 `reserved` 和确认后未提交工作区的 `uploaded` 两种中断状态：自然等待 15 分钟预留期后，正式 cleanup 一次领取并完成两个对象，Storage 均物理消失。自然定时触发及清理器崩溃／重试仍待验收。

### 显式导入旧匿名资料

登录和普通工作台操作不读取旧 IndexedDB 工作区，也不显示匿名与云端副本差异作为正常使用的前置条件。用户需要旧匿名内容时，可在已登录的设置页明确选择“导入旧版资料”；此时才只读旧匿名副本和它有可信归属的原件。

旧副本先生成 ZIP，再经过同一严格备份读取器检查、生成恢复计划。确认后重新分配业务身份，作为新副本追加到当前账号的最新云端工作区；账号非空也可导入，不覆盖已有资料。缺失原件须明确同意只恢复已包含内容。旧匿名资料和原件保持原样，不自动删除或转授另一账号的缓存权限。当前未提供旧登录账号缓存的自动恢复路径，详见[备份恢复](BACKUP_RESTORE.md)。

新副本不复用旧 `storagePath`；可用原件暂存在当前页面内存，按当前账号的私有 `用户 ID/资料版本 ID/资料 ID.扩展名` 路径重新上传。原件和工作区均获云端确认后才显示导入成功。同一恢复计划失败后重试不会重复新增；重新选择旧副本或 ZIP 再次导入会创建另一套副本，不自动去重。真实迁移验收以 [云端验收](CLOUD_E2E_ACCEPTANCE.md) 的实际记录为准。

### 初始云端读取与失败保护

已验证账号首次进入工作台或刷新页面时只读取云端快照。读取失败保留错误与未就绪状态，不能当成空账号，也不发起工作区写入。只有云端明确返回无工作区，才可按正常流程创建新的账号工作区。

重新连接会重试云端读取与原有 revision 保护。正常 Web 保存仍复用协调器队列，但其兼容本机接口仅连接会话内存适配器，不访问 IndexedDB 或旧同步元数据。页面编辑、上传暂存和尚未应用的审核操作不会跨刷新恢复；保存未确认时提示重试并保护离开、关闭或退出动作，不提供“保留本机草稿并退出”。Auth cookie 属于登录会话，不构成第二份正式资料库。

### 可选生成式问答与资料整理

普通 Auth、工作区保存和 Storage 使用上述公开连接配置与用户会话。启用生成式问答、资料分析、主题草稿或已有知识页更新建议，还需按 [MODEL_SETUP.md](MODEL_SETUP.md) 配置服务端模型变量，以及 `SUPABASE_SECRET_KEY`；旧项目可使用 `SUPABASE_SERVICE_ROLE_KEY`，二者只选一个。这些服务端密钥没有 `NEXT_PUBLIC_` 前缀，不进入浏览器，也不替代普通用户身份与范围核查。特权客户端还用于受保护索引动作与字符预算 RPC，Python 处理器不持有数据库密钥。

已登录云端账号在模型未配置时仍可使用明确标注的原文检索模式；部分配置缺失或账本不可用会报告未就绪。配置存在仅代表可尝试调用，不能证明供应商兼容性或模型质量。仓库不提交 `.env.local`；真实 Supabase 和模型调用状态以各环境的配置及实际请求为准。

2026-09-15 已在本地开发环境配置现有服务端账本密钥，用真实账号完成资料生成式问答、带引用笔记的云端保存／刷新恢复，以及 PDF 区域的解读、图片问答和中文练习生成。资料分析、两标签的人工接受，以及两资料生成主题后接受知识页、云端保存与刷新恢复均已通过；知识页包含 6 条跨资料原文引用。真实账本回读确认请求完成及固定区域身份；具体材料、故障修复与未验收边界见[云端验收](CLOUD_E2E_ACCEPTANCE.md)。开发页面整理通过显式 local runner 开关发起真实模型请求，不等同于生产持久后台整理。

### 可选语义索引与处理器

普通资料、笔记与已接受知识页搜索无需 AI 开关或 Embeddings 配置。登录且工作区已云端确认后，Web 的云端搜索调用 `/api/v1/search`；具体库或收件箱内的显式语义模式另需开启 `semanticSearch`，并配置服务端 `CONUO_EMBEDDING_BASE_URL`、`CONUO_EMBEDDING_API_KEY`、`CONUO_EMBEDDING_MODEL`。模型没有默认值，必须原生输出 1536 维向量。

`embedding-v1` 在首次任务领取时绑定模型配置指纹。更换 Base URL/模型需迁移重建，不能直接改环境变量继续使用旧索引。`CONUO_EMBEDDING_DAILY_CHAR_LIMIT` 默认每账号每 UTC 日 200,000 字符，正文与语义查询发送前预占，失败也计入；这是字符准入上限，不是货币预算。

Next.js 与受信 Python 处理器配置相同的 `CONUO_PROCESSOR_SECRET`，供 `/api/internal/indexing` 的 Bearer 验证。处理器显式运行，默认最多 5 项/40 秒，通过 HTTP 领取、读批次、提交与发布；不直接连接 Supabase。当前未部署 Celery、Cron 或云唤醒，关闭浏览器不会自动启动后台处理。操作、指纹和权限细节见 [SEARCH_INDEXING.md](SEARCH_INDEXING.md) 与 [Processor README](../apps/processor/README.md)。

### 可选彻底删除清理执行器

迁移 024 已在 staging 扩展资料删除为明确的另存内容选择，默认全部保留笔记、知识页和对话。选择、候选身份、完整内容指纹与预期 revision 由同账号服务端重新核对；同事务删除选中内容并写入防复活墓碑，人工批注或手工关系须先明确处理。旧环境仍可沿原协议默认保留另存内容，不能代替用户提交选择。具体粒度、模型缓存和在途边界见[彻底删除](PERMANENT_DELETION.md)。

迁移 004 只在资料元数据已安全删除后写入原件 cleanup outbox；迁移 005 为每个 canonical `originals` 路径加入有限租约、最多 5 次尝试和指数退避。迁移 017 的单历史版本清理复用同一个 outbox，只会写入不再被其他保留版本引用的路径。Next.js 的 `GET /api/internal/source-purge-cleanup` 不接收账号、资料或路径参数，只由 service-role RPC 认领对象，再删除 `originals` 桶中经 SQL 验证的路径并确认结果。`404` 被视为原件已不存在的幂等成功；其他失败只记录受控错误码，不返回 Storage 原始错误或路径。

该入口需要服务端 `SUPABASE_SECRET_KEY`（或旧版 `SUPABASE_SERVICE_ROLE_KEY`）以及至少 32 个可见 ASCII 字符的 `CONUO_CLEANUP_SECRET`。应用目录的 [vercel.json](../apps/web/vercel.json) 已准备每日 `03:17 UTC` 的 Vercel Cron 调用；部署时可改用 Vercel 的 `CRON_SECRET`，因为 Vercel 会将其以 Bearer Authorization 发送给 Cron Route，或把 `CONUO_CLEANUP_SECRET` 设为同一值。调度定义与验证方法见 [Vercel Cron 文档](https://vercel.com/docs/cron-jobs/manage-cron-jobs)。

历史上前 19 份迁移已在原连接项目执行，且已完成 schema、私有桶、Storage policy 与 `public` 表 RLS 核验；第 11 份的两张笔记读投影表、两条读取 policy、一个工作区投影 trigger 与当时 0 个 Security Advisor error 均已实际核对。第 12 份 `20260913233000_import_parse_leases.sql` 已额外核验私有表 RLS、认领与完成 RPC、以及 `save_workspace` 租约保护；第 13—16 份的五张只读投影表与四个工作区触发器也已在线核对。第 17 份已核对两个 `source_purges` 字段、两个 RPC 与仅认证用户执行的权限边界。第 18—19 份已用真实账号验证资料库投影、首次笔记保存和刷新后的云端重载。这不代表 Vercel 环境变量已配置或实际执行过 Storage 删除，也不代表真实跨设备解析已经通过；后两者仍必须以目标环境设置、outbox 记录和两设备联调核验。资料 UI 中的 `pending` 表示元数据已安全删除且等待清理；只有 outbox 的所有对象确认完成后，父级 purge 才会显示 `completed`。

### 可选账号注销执行器

账号设置会先显示仅含数量的影响预览；用户输入当前邮箱、密码和 `DELETE` 后，`prepare_account_deletion` 在一个数据库事务中写入不可撤回的账号注销记录，枚举账号首层目录下的 Storage 对象（包括上传失败留下的孤立对象），并封锁该账号的工作区、检索、上传、下载和普通 API 访问。未完成的资料彻底删除任务会移交到账号注销队列，避免两个 worker 重复操作同一原件。

`GET /api/internal/account-deletion-cleanup` 只能从 service-role RPC 获取租约对象，先删除已租约的 Storage 对象，再领取可删除的 Auth 账号并调用 Supabase Auth Admin。Storage `404` 和 Auth `404` 都按幂等成功处理；可重试故障最多尝试五次。删除 Auth 前、以及 Auth 删除后最终确认时，数据库都会再次扫描 `storage.objects`；若发现迟到对象，会重开 Storage 队列而不是把账号标为完成。`202609120007_account_deletion_embedding_fence.sql` 同时取消已排队或已租约的向量任务、清空模型结果缓存，并拒绝新的模型/向量任务预约。

浏览器在确认请求成功后会停止该账号的问答、整理和导入，清理会话内存快照、暂存原件和独立审核状态，保留当前页面的身份封锁。已由 Web 会话管理的账号不会因为注销通知自动读取或修改旧 IndexedDB；迟到结果只封锁和清理发起账号，不能清理当前另一个账号。刷新后由 Auth 和服务端注销闸门重新核验。旧副本与用户下载的 ZIP 不由本轮 Web 策略自动清除。

该入口与资料清理入口共用 `CONUO_CLEANUP_SECRET`（或 Vercel `CRON_SECRET`）及服务端 Supabase admin key。应用目录 [vercel.json](../apps/web/vercel.json) 已准备每天 `03:22 UTC` 的受保护 Cron 调用。账号注销迁移属于上方的部署链；在任一项目启用清理器前，必须确认对应迁移已成功完成，并分别核验 Vercel 环境、Storage 删除和 Auth Admin 删除。

## 邮件与回调

开发环境的 Auth Site URL 设置为实际使用的地址，例如 `http://127.0.0.1:3000`。Redirect URLs 加入该来源的 `/auth/callback` 和 `/auth/callback?next=/auth/reset-password`；若使用 localhost 或其他端口，需单独加入对应地址。生产环境应使用确定的 HTTPS 域名。

默认邮件流程通过 `/auth/callback` 交换 PKCE code，然后调用 `getUser` 确认身份。链接需要在发起请求的浏览器内完成。若需要邮箱链接能在另一浏览器打开，可在 Supabase Email Templates 中使用 token hash 验证模板：

注册确认邮件：

```html
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup"
  >确认邮箱</a
>
```

密码恢复邮件：

```html
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery"
  >重置密码</a
>
```

`/auth/confirm` 只接受列出的验证类型，不接受任意跳转地址。实际邮件发送仍受所用项目的邮件服务与限额约束；需要在真实项目验证发送、过期、重复使用和恢复流程。

staging 已使用受控真实邮箱通过注册确认和同浏览器 PKCE：`/signup` 返回 200，邮件 `/verify` 返回 303，随后 PKCE `/token` 返回 200。真实找回密码邮件、过期链接、跨浏览器点击和刷新会话仍待验收。当前 Email provider 已启用，但未配置自定义 SMTP；默认确认模板使用 `{{ .ConfirmationURL }}`，Supabase 控制台要求先启用自定义 SMTP 才能编辑模板。因此上方 token-hash 模板目前只是目标配置，尚未在 staging 生效。

## 数据保护与版本

| 对象         | 当前实现                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 登录状态     | 浏览器 SSR cookie 客户端；服务端每次数据请求用 `getUser` 验证                                                                                                                            |
| API 身份绑定 | `X-Conuo-User` 与已验证账号一致才执行，拒绝账号切换后的旧工作区请求                                                                                                                      |
| 工作区       | 每账号一条 JSONB 兼容快照，是浏览器唯一写入权威；仅该账号可 SELECT；无 authenticated 直接写权限，仍受 3 MiB 上限                                                                         |
| 保存         | `save_workspace` 用 `auth.uid()` 选择账号，原子比较 revision，并在同一事务同步真实资料/版本/块及任务与笔记读投影；冲突返回 HTTP 409                                                      |
| 笔记读投影   | `notes` 与 `note_versions` 由 `project_workspace_notes` 在工作区快照写入同一事务内维护，仅用于读取；浏览器没有直接写入表的路径，快照合同与写入权威不变                                   |
| 对话读投影   | 第 13 份迁移已由 `project_workspace_conversations` 在同一事务维护 `conversations` 与 `conversation_messages`；浏览器写入合同仍保持不变                                                   |
| 批注读投影   | 第 14 份迁移已由 `project_workspace_annotations` 在同一事务维护版本绑定的 `annotations`；浏览器写入合同仍保持不变                                                                        |
| 关系读投影   | 第 15 份迁移已由 `project_workspace_concept_relations` 在同一事务维护 `concept_relations`，保留双页基线、证据与关系 revision；浏览器写入合同不变                                         |
| 知识库读投影 | 第 16 份迁移已由 `project_workspace_learning_spaces` 在同一事务维护 `learning_spaces`，保留书架顺序和知识库元数据；浏览器写入合同不变                                                    |
| 版本与索引   | 独立不可变正文 digest 和 chunk hash，所有保留历史原件按 owner/version/source 核对；新搜索和问答只读取当前可用版本                                                                        |
| 文件         | `originals` 私有桶，路径为 `用户 ID/资料版本 ID/资料 ID.扩展名`                                                                                                                          |
| 文件权限     | 仅用户自己的首层目录可读取、上传与删除；不允许覆盖原件，替换须使用新版本                                                                                                                 |
| 文件版本     | PDF、DOCX、Markdown、TXT 可预览后确认跨格式换版；在会话内存核验原件后发布新版本并等待云端确认，上传队列覆盖当前及全部保留历史原件，完成路径按确切版本回填                                |
| 导入解析租约 | 第 12 份迁移已在连接项目执行；已核验私有租约表的 RLS、认领/完成 RPC 与 `save_workspace` 令牌保护。真实两设备、断网与竞态联调仍待完成                                                     |
| 请求与缓存   | JSON 验证、流式读取大小限制、同来源修改、个人响应 no-store                                                                                                                               |
| 问答         | 服务端从已认证账号的已保存资料检索；配置完整时使用有上限的原文上下文调用模型并绑定引用，调用前后复核账号、范围、版本和 AI 权限；未配置模型时返回原文摘录                                 |
| 资料整理     | `/api/v1/organize` 处理资料摘要／标签、知识主题草稿和已有知识页更新建议，与问答共用账号次数、并发与请求缓存；未配置时明确不可生成，不伪造模型结果                                        |
| 知识页更新   | 请求只携带目标页 ID、正文 revision 与更新时间，服务端从账号工作区读取真实目标；生成前后及缓存恢复时复核完整页面、资料版本和 AI 权限，返回待审核的逐项修改，不自动覆写页面                |
| 模型请求账本 | 独立 `ai_requests` 表和服务端预占函数；浏览器无直接表/函数权限，按账号限制同时运行请求与每日次数；原始迁移已在 PGlite 测试，真实单账号请求已完成预占及结果写入；完整并发与清理矩阵待验证 |
| 普通搜索     | 资料来自规范化 RPC，笔记/已接受知识页当前仍来自账号快照；草稿默认排除，类型/标签/日期先确定范围；第 11 份读投影尚未改变此检索路径，也不受 AI 开关影响                                    |
| 向量任务     | 持久队列、租约 token、cursor、取消/重试和完整批次发布；`/api/v1/indexing` 仅当前账号可查看和控制，内部执行需服务秘密及 profile 指纹                                                      |
| 彻底删除清理 | 资料 purge outbox 使用 service-role 租约、心跳、受控错误码与最多 5 次退避；`/api/internal/source-purge-cleanup` 仅清理 SQL 认领的 canonical `originals` 路径                             |
| 账号注销     | 影响预览、邮箱/密码/`DELETE` 确认、Storage/Auth 两阶段 outbox、访问封锁、向量和模型任务栅栏；`/api/internal/account-deletion-cleanup` 只处理 SQL 租约对象                                |

原件上传成功后，才能把相应 `storagePath` 保存到工作区。上传与快照保存不是跨服务事务，失败可能留下该账号自己的孤立原件；后续需要幂等清理队列。上传重试遇到同一路径时会比较真实字节的 SHA-256，不能仅凭同名判定为同一文件。

文件替换先通过 `prepareFile` 进行无存储副作用的浏览器预览。用户确认后，不可覆盖地把新原件暂存在当前会话内存并回读核验，再复核账号、预期版本、归属与容量，更新资料版本。资料名称、标签、归属和权限保持；保存队列上传原件并等待云端快照确认。发布后的失败保留当前页面原件与修改供重试或导出，不将当前版退回，也不删除仍被引用的字节。刷新不会恢复尚未保存的内存内容。

云端队列会遍历每份资料的当前及所有历史版本，包括尚未被引用的旧版。尚无 `storagePath` 的新原件先核对当前会话暂存字节再上传；期间当前文件变成历史版时，上传结果只回填匹配的原版本。队列重新覆盖最新完整版本链后才提交云端快照。普通阅读和导出按当前账号、确切版本从私有 Storage 读取正式原件，不自动查找旧 IDB 字节。仍带原件句柄却读取不到暂存字节、身份变化或上传失败时明确报错，不把新版原件当作旧版，也不宣称已保存。详见[文件版本说明](FILE_VERSIONS.md)。

个人 ZIP 备份必须在已登录的云端账号下恢复为新增副本。所有业务标识重新分配，当前及历史版本的旧 `storagePath` 一律移除。包内原件使用新的会话暂存键，由同一保存队列上传到当前账号的 `owner/version/source` 路径；恢复操作等待原件和工作区云端确认后才成功。不会创建未登录的本机工作区，不导入旧登录凭据、AI 授权或模型请求账本。已有全局 AI 设置保持不变，新增资料默认关闭 AI；恢复的整理任务不能检查旧账本，用户可按当前资料明确重新生成。操作和异常边界见[备份恢复](BACKUP_RESTORE.md)。

用户明确接受原件不完整的备份时，对应当前或历史版本保留 `originalMissing: true`，去除不可用的 `blobKey` 和 `storagePath`，从而允许已有正文与其他完整资料正常同步；阅读和再次导出继续显示该版原件缺失。这与仍持有原件句柄但读取、校验或上传失败不同，后者仍会阻止同步并报错。补回原文件采用新版本，不给旧历史版填入当前版字节。

目前 API 检查快照结构、账号路径和版本，并未逐份向 Storage 核验对象实际属性。staging 已完成跨账号 Storage 隔离，以及上传中断、历史版本、资料和账号注销的带数据 Storage/Auth 删除主链路；自然 Cron、清理器崩溃／租约恢复、跨设备竞争和生产环境仍待联调。文件发布完整性、文件和通用 API 的持久按用户限流仍需后续实现和联调。新增模型账本的次数预占不代表其他接口已经具备持久限流，也不能据此宣布正式上线验收完成。

浏览器文件导入及替换上限为单文件 **30 MiB**；底层 Storage 上传校验与桶配置的 50 MiB 上限不扩大应用入口的限制。每份资料最多保留 **200 个历史版本**，另有当前版；达到上限拒绝新增，不自动裁剪。工作区 JSONB 的当前与历史文字、切块、笔记及整理任务／结果合计上限 **3 MiB**，原件字节单独存储（数据库按 JSONB 文本大小计算，可能略大于紧凑 JSON）。这是首个可运行增量的限制，不是最终产品容量。超限会明确拒绝保存，保留当前页面修改供重试或导出；不会显示已保存。

知识页更新的基础快照、逐项应用／忽略记录与笔记正文 revision 仍使用现有工作区 JSONB 保存。第 11 份迁移会在同一工作区事务内把这些笔记及历史版本投影到 `notes` 与 `note_versions`，但不替换浏览器写入、备份或冲突处理所依赖的快照合同。新历史版本可保存当时的引用、状态、AI 标记、所属知识库和正文 revision，旧记录保持兼容。每次更新需包含目标页已有引用的全部资料，与新增资料合计最多 10 份；目标页限制为 100 个结构块、2 万字符可见正文、6 万字符 HTML，不会自动截断。审核、历史恢复及纯文本整块修改的边界见 [资料整理](ORGANIZATION.md)。

接受更新前，应用会检查转义后的正文不超过 20 万字符，并将新增历史、审核记录计入完整下一工作区；紧凑 JSON 的 UTF-8 大小超过 3 MiB 时整批拒绝，原正文不变，不自动删历史或截断文字。此预检查不能代替数据库的 JSONB 大小校验；最终 JSONB 文本可能更大，仍需以保存响应确认同步成功。

浏览器只在当前页面内存保留尚未确认的编辑。工作区 revision 冲突时，由用户明确选择重试、导出当前页面内容或载入云端；离开和退出保护不提供跨刷新恢复的本机草稿。跨账号进行中请求由应用层身份与会话代次隔离，API 同时做账号绑定。私有桶不提供永久公开链接。

模型请求的结果缓存和账本元数据与工作区快照分表存储。缓存超过 24 小时、请求元数据超过 7 天时，由该账号**下次预占模型请求**触发惰性清理；没有定时清理，也不保证到期立即删除。资料删除、AI 权限撤销后的请求会复核范围，但原件和所有派生记录的完整删除生命周期尚未完成。保留规则、并发次数和失败计数的细节见 [MODEL_SETUP.md](MODEL_SETUP.md)。

## 验证

`apps/web/src/lib/supabase/` 下的测试检查未知字段、非法标识、账号路径、重复 ID、负 revision、问答范围、跨站请求、真实流长度，以及会话与密码更新的账号切换竞态。这些是本地输入与请求边界测试，**不能代替数据库 RLS 联调**。

`supabase/tests/workspace_isolation.sql` 可在独立本地 Supabase 数据库中运行，验证两个测试账号之间的读取隔离、直接写入禁用、创建与陈旧 revision 拒绝；执行后事务整体回滚。不要在正式账号数据库中跑测试夹具。没有数据库凭据时，本仓库不声称这些 SQL 测试已通过。

原生产 Supabase 最后一次只读核验为 19 份迁移；第 11—19 份的 RLS、权限、投影触发器和基础真实账号读写证据属于该环境的历史基线。独立 staging 已从零应用全部 27 份迁移，并完成两个账号的文件隔离、并发 CAS、真实注册确认邮件、孤立上传、资料／历史版本清理及账号注销的 Storage/Auth 主链路。仍需验证刷新会话、真实找回密码邮件、过期与跨浏览器链接、真双设备、网络中断、自然 Cron、清理失败恢复、单份文件超限及快照超限。生产发布前必须重新实时核对原生产迁移历史，不能用 staging 结果替代。

第 13 份 `20260914000100_normalized_conversations_projection.sql` 已在本地 PGlite 中随完整迁移链执行，覆盖消息顺序与证据、RLS 账号隔离、禁止浏览器直接写入、账号注销隐藏、工作区级联删除、revision CAS 更新/裁剪，以及重复回答尝试导致整次工作区保存原子回滚。它也已应用到连接项目，并完成表、RLS、权限、policy 与触发器核验。

第 14 份 `20260914000200_normalized_annotations_projection.sql` 同样已在本地完整迁移链执行，覆盖资料/版本身份、原文与批注内容、可选页码、RLS 账号隔离、禁止直接写入、账号注销隐藏、CAS 更新/裁剪、不可变定位身份、级联删除和重复标识原子回滚。它也已应用到连接项目，并完成表、RLS、权限、policy 与触发器核验。

第 15 份 `20260914000300_normalized_concept_relations_projection.sql` 已在本地完整迁移链执行，覆盖关系类型、双页知识快照、引用证据、人工/AI 来源、软删除与连续 relation revision；同时验证同义词、相关概念和冲突观点的无向去重、前置知识的方向保留、冲突双方独立证据、RLS 账号隔离、禁止直接写入、账号注销隐藏、CAS 裁剪及工作区级联删除。它也已应用到连接项目，并完成表、RLS、权限、policy 与触发器核验。

第 16 份 `20260914000400_normalized_learning_spaces_projection.sql` 已在本地完整迁移链执行，覆盖书架顺序、名称、目标、颜色、归档状态与创建身份，验证迁移回填、RLS 账号隔离、禁止直接写入、账号注销隐藏、创建身份不可漂移、CAS 重排/裁剪、保留标识与重复标识原子回滚，以及工作区级联删除。它也已应用到连接项目，并完成表、RLS、权限、policy 与触发器核验。

生成式链路的 `apps/web/src/lib/ai/requests-sql.test.ts` 已在 PGlite 内存 PostgreSQL 中执行原始账本迁移，直接验证角色权限、预占、每日次数、同请求复用和清理边界；这些 SQL 测试不是 mock。当前真实项目的 19 项迁移已包含账本，单账号真实生成请求已完成预占与结果写入；跨实例原子预占、额度耗尽、缓存复用及清理仍待真实并发矩阵，不能由单连接 SQL 测试或单次模型成功替代。

此前搜索索引增量中，`retrieval-sql.test.ts` 已以真实 pgvector 执行 001/002/003，45 项通过；另有实际 Python → HTTP → Next.js → PGlite 的两项贯通，验证 18 块两批发布及处理中换版后拒绝旧提交。当时全仓 49 文件/1396 项、Python 37 项，以及构建、类型、静态和格式检查通过，计数和测试替身边界见 [开发状态](IMPLEMENTATION_STATUS.md)。这些记录仍不代表真实 Supabase、供应商向量质量、多连接竞争或云调度验收。

此前 ZIP 恢复阶段测试覆盖原件暂存与回读、最新工作区合并、同计划重试、同账号加载云端副本竞态及恢复任务账本隔离。fake-indexeddb 的重开证据只代表当时的本机实现，受控云端 IO 也不代替真实 Storage 联调；历史记录见[恢复阶段说明](IMPLEMENTATION_STATUS.md#zip-备份新增副本恢复2026-09-12)，当前 Web 云端唯一存储的验证以[最新开发状态](IMPLEMENTATION_STATUS.md)和[云端验收](CLOUD_E2E_ACCEPTANCE.md)为准。

使用所选模型还需核查摘要/比较质量、引用真实性、取消和超时、费用，以及资料/权限在调用期间变化时的结果丢弃。适配器和 API 的 mock 测试覆盖请求与代码边界，与本地 SQL 测试一同作为开发证据，均不能替代真实服务联调。

此前整理／知识页更新阶段的三份服务端定向测试共 145 项通过，覆盖零项更新、服务器绑定旧段落与引用、目标页编辑竞态、AI 撤权、缓存基线和原有整理回归。模型与 Supabase 返回由测试模拟；未因此增加真实环境联调结论。该阶段历史导出另有 21 项导出／Markdown 定向测试，格式说明见 [EXPORT_FORMAT.md](EXPORT_FORMAT.md)。这些是当时范围的记录，不是文件替换增量的最新验收结果；最新记录见 [开发状态](IMPLEMENTATION_STATUS.md)。

## 后续工程边界

资料、保留版本、切块、pgvector 混合检索及持久索引 outbox/租约/发布已接通；第 11 份迁移已为笔记建立快照兼容的事务性读投影，第 13—16 份又在线建立对话、消息、批注、知识关系与知识库书架读投影。原快照仍承担客户端协议与唯一浏览器写入权威；这些实体的独立写入合同、关系参与检索、其他实体规范化及脱离 3 MiB 限制仍待完成。已有有界 Python 向量处理器，尚未部署云调度、服务端解析或页面关闭后可靠执行的服务。浏览器自动资料分析、主题草稿与知识页审核仍是独立链路，默认关闭且只在工作台运行，详见 [资料整理](ORGANIZATION.md)。资料问答、区域视觉及开发页面手动整理已有真实模型联调；生产持久后台整理和向量供应商质量仍待验收。

当前开发环境已接入 DeepSeek，embedding 服务仍待配置；当前未配置环境下 `/api/v1/ask` 的 `mode` 为 `extractive`，不会调用外部模型，也不会把摘录标成模型推理。服务端生成结果的 `mode` 为 `model`，仅在所需配置与真实调用成功后返回。网页预览可通过受控服务端抓取公开 HTML，生产环境必须登录；loopback 开发环境可本机验证。网页提取不调用模型，URL、DNS、跳转与负载限制见 [WEB_IMPORT.md](WEB_IMPORT.md)。

资料彻底删除已有 metadata purge、tombstone、Storage cleanup outbox 及受保护执行入口；本地新增逐篇笔记／知识页含历史和整对话的选择清理、另存内容防复活与相关缓存收窄，见[彻底删除说明](PERMANENT_DELETION.md)，该第五份待迁移尚未应用；账号注销已有 Storage/Auth 两阶段 outbox、访问封锁与模型任务栅栏。两者仍需在真实 Supabase/Storage/Auth 和已部署调度中验证崩溃、重试、跨账号隔离、迟到对象和最终物理删除。003 的 `retained=false` 与取消状态不是数据永久清除；`deleteSourceBlob` 也只删除当前用户指定原件，不等于账号清除已验收。笔记和知识页已支持 Markdown、原始内容和历史版本导出，见 [EXPORT_FORMAT.md](EXPORT_FORMAT.md)；个人 ZIP 的新增副本恢复已实现，服务端灾难恢复、删除记录重放与真实云端恢复演练仍需独立实现和验收。

文件替换、历史引用和 ZIP 新增副本恢复已提供 Web 云端保存流程，各版原件可独立上传及导出；真实云端并发换版、跨设备下载、断网恢复仍需联调。匹配旧历史内容的文件可再次选择并明确确认为新版本；当前版明确缺失原件时，也可用同哈希原文件建立新版本修复。登录且同步完成后可通过服务端影响预览与明确确认单独清理一个历史版本；也可直接从归档恢复一个确切版本为当前版。文件解析仍在浏览器执行，不由模型或持久后台任务代办。

参考：[Supabase SSR 客户端](https://supabase.com/docs/guides/auth/server-side/creating-a-client)、[密码与邮件流程](https://supabase.com/docs/guides/auth/passwords)、[Storage 访问控制](https://supabase.com/docs/guides/storage/security/access-control)。
