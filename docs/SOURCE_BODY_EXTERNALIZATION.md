# 资料正文外置：21-1 设计核对与使用点清单

本文是 WP-21 的 21-1 交付物。它只记录使用点、后续接口设计、迁移边界、回滚方案和测试计划；本子步骤不修改保存格式、不新增运行时代码，也不打开 `EXTERNAL_BODIES`。

## 1. 核对方法与结果

按手册运行了三条命令（排除 Web 测试文件的前两条保持原命令，移动端按原命令包含测试）：

```sh
rg -n "\.text\b" apps/web/src/lib apps/web/src/components --glob '!*.test.*'
rg -n "\.chunks\b" apps/web/src/lib apps/web/src/components --glob '!*.test.*'
rg -n "source\.text|version\.text|\.chunks" apps/mobile/src
```

当前结果为 Web `.text` 297 行、Web `.chunks` 102 行、移动端 44 行。结果中既有资料正文／资料切块，也有回答字段、界面文案、DOCX block、知识编辑文本等同名字段；下表只列实际读取 `Source`／`SourceVersion` 正文或切块的使用点。生产代码以“单份资料正文”“多份资料正文”“版本与持久化校验／生产”分类；移动端测试夹具单列。

## 2. Web 使用点清单

### 2.1 需要单份资料正文：阅读、定位、批注和资料级操作

这些位置都应在 21-7 的消费者改造中先 `await ensureSourceBody(source, versionId?)`。外置快照加载后的空 `text`／`chunks` 不能直接进入这些路径。

| 文件与行                                                                              | 当前读取                                                                  | 21-7 改法                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/web/src/lib/annotations.ts:79-81`                                               | 用 `source.text` 核对批注锚点和引用                                       | hydrate 当前 source 后再核对；失效仍返回既有不匹配结果                                 |
| `apps/web/src/components/annotation-selection.ts:17-194,230-276`                      | 读取 `source.chunks`、`source.text` 建立选择范围、UTF-16 偏移和旧锚点兼容 | 打开资料或收到选择事件前 hydrate；保持原始正文偏移不变                                 |
| `apps/web/src/components/comparison-reader.tsx:591-609`                               | 显示单份比较资料正文并按段落拆分                                          | 进入比较阅读前 hydrate 对应版本                                                        |
| `apps/web/src/lib/comparison-answer.ts:86-93`                                         | 检查 source 正文和 chunks 是否相互包含                                    | 比较请求组装前逐份 hydrate；服务端问答消费者在 21-4 另行改造                           |
| `apps/web/src/components/concept-relations-panel.tsx:124,138`                         | 用 source 正文核对引用，并用正文／chunks 判断可分析性                     | 面板打开或执行分析前 hydrate                                                           |
| `apps/web/src/lib/concept-relations.ts:50`                                            | 用 source 正文核对关系引用                                                | 关系操作入口 hydrate 当前资料                                                          |
| `apps/web/src/components/file-replacement-form.tsx:126,230-274`                       | 预览 candidate 正文、切块数量和解析状态                                   | 新版本上传解析结果仍可直接使用；已有外置版本需先读取正文元数据，预览正文时 hydrate     |
| `apps/web/src/components/knowledge-update-panel.tsx:96`                               | 用正文和 chunks 判断是否可分析                                            | 打开面板前 hydrate                                                                     |
| `apps/web/src/lib/knowledge-update.ts:100`                                            | 用正文核对知识更新引用                                                    | 生成或应用更新前 hydrate 当前版本                                                      |
| `apps/web/src/lib/markdown-selection.tsx:71-93`                                       | 用正文投影 Markdown 可见文字并定位选择                                    | 选择器挂载前 hydrate                                                                   |
| `apps/web/src/lib/markdown-excerpt.ts:331-445`                                        | 遍历 chunks、在正文中找 chunk 偏移并生成原文摘录                          | 摘录模式先 hydrate；若正文仍不可读，保持既有失败提示                                   |
| `apps/web/src/lib/excerpt-to-knowledge.ts:106-277`                                    | 筛选 chunks、核对正文包含关系、校验选段                                   | 提交选段前 hydrate                                                                     |
| `apps/web/src/components/learning-continuation-card.tsx:29-33`                        | 从 source 正文生成学习卡片可见文本                                        | 卡片展开前 hydrate                                                                     |
| `apps/web/src/components/reader-outline.ts:98-152`                                    | 解析正文目录、遍历 chunks 并生成 locator                                  | 阅读器目录加载前 hydrate                                                               |
| `apps/web/src/components/reader-utils.ts:54-61`                                       | 在 chunks 和正文中解析 citation quote                                     | citation 跳转前 hydrate                                                                |
| `apps/web/src/components/reader/reader-shell.tsx:492-510,940-987,1427-1579,2640-2731` | DOCX 结构、citation 跳转、页内检索、选段、正文渲染和 chunk 查找           | reader 打开或切换版本时调用 `ensureSourceBody`，显示加载状态；PDF 画布仍走原有字节读取 |
| `apps/web/src/components/workspace/panels/recognized-content-panel.tsx:108-240`       | 筛选、搜索、预览和引用 source chunks                                      | 面板打开前 hydrate；只显示元数据时可只读 meta                                          |
| `apps/web/src/components/workspace/panels/source-detail-panel.tsx:286,389`            | 显示 chunk 数量并按 chunkId 取正文预览                                    | 详情基本信息只读 meta；选中 chunk 或 OCR 入口需要 hydrate                              |
| `apps/web/src/components/workspace/workspace-shell.tsx:1678`                          | 从 source chunks 查找当前引用                                             | 引用操作前 hydrate                                                                     |
| `apps/web/src/lib/workspace-coordinator/questions.ts:201`                             | 用 source 正文核对 resolved chunk                                         | 问题上下文复核前 hydrate                                                               |
| `apps/web/src/components/organization-panel.tsx:84`                                   | 用正文／chunks 判断资料是否可整理                                         | 打开整理面板时 hydrate；真正整理服务端属于多资料消费者                                 |
| `apps/web/src/components/web-version-panel.tsx:37-38`                                 | 只读取 `version.text.length` 展示字符数                                   | 改为 `body.textLength`；内联版本继续使用正文长度                                       |
| `apps/web/src/lib/ocr-assembly.ts:28,66`                                              | OCR 派生版本组装前读取当前 source chunks，生成新的正文                    | 外置改造前保持当前版本内存正文；21-7 应先 hydrate 后再执行派生组装                     |

### 2.2 需要多份资料正文：检索、问答、整理、索引与批量输出

这些位置不能把快照里的空正文当作“没有内容”。21-4 以后服务端使用 `hydrateSourcesForRequest` 或专用云端查询；浏览器批量操作按清单逐份调用 `ensureSourceBody`。

| 文件与行                                                     | 当前读取                                                  | 后续改法                                                                         |
| ------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/web/src/lib/ai/grounding.ts:55,126-162,210,411,524`    | 从多个 source 读取前缀、chunks、正文包含关系和证据        | 21-4 在范围校验后补齐外置正文；正文仍只来自数据库当前版本                        |
| `apps/web/src/lib/ai/organization.ts:67-139`                 | 对多个 source 检查正文、遍历 chunks 并绑定引用            | 21-4 与整理路由一起 hydrate；摘要等派生数据不替代原文                            |
| `apps/web/src/lib/ai/query-rewrite.ts:34-39`                 | 将多份 source 正文前缀作为改写上下文                      | 21-4 读取当前版本正文后再构造 prompt                                             |
| `apps/web/src/lib/cross-library-ask.ts:83-90`                | 检查多资料正文和 chunks 的版本一致性                      | 21-4 由问答请求统一补齐                                                          |
| `apps/web/src/lib/retrieval.ts:414-419,508,525`              | 选段校验、遍历 source chunks、解析 citation               | 问答范围校验后补齐；引用仍绑定规范切块                                           |
| `apps/web/src/lib/search.ts:137-312`                         | 本机关键词搜索、chunk 查找、snippet 和正文包含校验        | 外置资料改走 `searchCloud`；内联资料保留本机路径                                 |
| `apps/web/src/lib/server-search.ts:124,245-267`              | 云端候选的 chunk 查找、正文包含校验和 citation            | 读取结果已来自数据库；21-4 的 AI 请求只需补齐快照中外置 source 的正文边界        |
| `apps/web/src/lib/question-context.ts:40-41`                 | 把所选 source 的正文和 chunks 放进上下文指纹              | 外置版本使用 `body.digest`，内联版本保持现有字段                                 |
| `apps/web/src/lib/organization-runner.ts:56-60`              | 后台整理候选检查正文和 chunks                             | 21-4 通过 service RPC 补齐，不能从空快照整理                                     |
| `apps/web/src/lib/ai/source-summary.ts:120-272`              | 对章节分组中的 chunks 读取文本、计算字符数和页范围        | 摘要任务读取数据库正文／切块；摘要正文仍是不可引用导航数据                       |
| `apps/web/src/lib/supabase/summary-task-runner.ts:157-320`   | 组装章节 evidence、summary 和 chunk 文本                  | 21-4 后从 service-side source body 读取，保留当前版本绑定                        |
| `apps/web/src/lib/supabase/embedding-task-runner.ts:178-201` | 批量读取 chunk 文本、计算字符数并发送 embedding           | 21-4 后使用 service-side body；保留额度、租约和当前版本检查                      |
| `apps/web/src/lib/export-scope.ts:153-164`                   | 对多个 retained versions 检查 chunks 和引用正文           | 浏览器导出前逐份 hydrate；21-7 的外置工作区必须仍能导出                          |
| `apps/web/src/lib/export.ts:126,282-406`                     | 读取正文、chunks、引用和导出文件内容                      | ZIP 导出逐份 `ensureSourceBody`；外置标记保留，导出格式仍输出正文文件            |
| `apps/web/src/lib/backup-archive.ts:410-415,529-531`         | 校验每个版本 chunks 是正文子串并写入正文／chunks 文件     | 备份前逐版本 hydrate；21-7 保持旧备份格式兼容                                    |
| `apps/web/src/lib/backup-restore.ts:64-70,470-493,760-761`   | 校验恢复版本正文与 chunks，清空副本正文，并判断是否有正文 | 恢复新副本走 21-5 分段上传；外置版本只保留 body manifest，不用空正文覆盖正式数据 |

### 2.3 生产、校验和版本处理点

这些位置不是普通阅读入口，但决定外置正文能否保存、恢复和保持不可变，必须在 21-5／21-6／21-7 一起处理。

| 文件与行                                                      | 当前读取或写入                                                          | 后续改法                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/web/src/lib/import.ts:200-242,311-424,467-479`          | 解析文件、写入 `source.text`／`source.chunks`、按正文切块和设定覆盖状态 | 新版本先保留现有内联导入；21-7 开关打开时保存前分段上传并写 body manifest          |
| `apps/web/src/lib/seed.ts:53-54`                              | 为示例资料生成正文大小和 chunks                                         | 示例资料保持内联；外置 schema 夹具另行构造                                         |
| `apps/web/src/lib/web-import.ts:25-30`                        | 校验网页预览和选定正文                                                  | 网页导入仍是内联正文；若版本被外置，操作前 hydrate                                 |
| `apps/web/src/lib/source-versions.ts:232,273,300`             | 校验候选版本 chunks、chunk 文本和新版本副本                             | 21-6 只允许外置版本使用 digest／body metadata；正文版本仍不可变                    |
| `apps/web/src/lib/supabase/validation.ts:387,471-474,529-534` | workspace/source/version schema 检查正文、chunks 和 chunk 是正文子串    | schemaVersion 2 增加可选 body；外置版本改为校验 digest、长度、数量和数据库权威版本 |
| `apps/web/src/lib/sync-conflicts.ts:801`                      | 读取 annotation text anchor 字段，不读取资料正文                        | 归类为只需批注元数据；真正核对正文仍由 annotations／reader 路径负责                |
| `apps/web/src/lib/docx-structure.ts:310-326`                  | 用 sourceText 与 DOCX block 文本对齐正文偏移和 chunks                   | DOCX 阅读前 hydrate；解析新导入仍可使用内联正文                                    |

## 3. 移动端使用点

移动端本轮不改代码（21-8 才实施）。21-7 之后若允许 Web 产生 schemaVersion 2，必须先完成下列读取改造并补合同测试：

| 文件与行                                                 | 当前读取                                       | 计划                                                    |
| -------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| `apps/mobile/src/core/reader.ts:29-33`                   | 过滤和排序 source chunks                       | 阅读器按需请求正文 API，内存填充后再过滤                |
| `apps/mobile/src/core/contracts.ts:185-236`              | 用 source.text 查找 chunk 区间、校验正文和切块 | 合同接受 `body`，外置版本先加载正文，不把空正文视为有效 |
| `apps/mobile/src/core/draft-recovery.ts:172`             | 从 source.text 恢复草稿范围                    | 恢复前按 versionId 加载正文                             |
| `apps/mobile/src/App.tsx:1434-1443`                      | 首次学习卡片读取第一个 chunk 的正文和引用字段  | 打开卡片前按需加载；引用仍绑定当前版本                  |
| `apps/mobile/src/components/SourceReader.tsx:327,398`    | 判断正文是否为空并显示正文结束标记             | 加载状态与外置正文状态分开处理                          |
| `apps/mobile/src/components/HomeOverview.tsx:49`         | 用正文是否为空判断资料可读状态                 | 使用 body metadata／加载状态                            |
| `apps/mobile/src/core/contracts.test.ts:79,147-151`      | 合同测试构造和校验正文／chunks                 | 21-8 增加 schemaVersion 2 与 body 夹具                  |
| `apps/mobile/src/core/reader.test.ts:49-111`             | 测试 chunks 版本、顺序和过滤                   | 增加外置正文加载后的相同断言                            |
| `apps/mobile/src/core/web-import.test.ts:74-120,270-274` | 测试导入正文、大小、chunks 子串关系            | 保持 schemaVersion 1 内联导入回归                       |
| `apps/mobile/src/core/pdf-import.test.ts:52-62`          | 测试 PDF 页 chunks 和正文                      | 保持内联解析回归，外置读取测试放在 21-8                 |

## 4. 同名字段但不是资料正文的命中

三条 `rg` 命令还命中了下列数据，它们不能被 `ensureSourceBody` 改造：

- `answer-stream.ts`、`answer-memory.ts`、`answer-verification.ts`、`knowledge-update.ts` 和 `knowledge-update-withdrawal.ts` 中的回答、编辑候选和模型段落 `text`；这些是回答或派生编辑数据。
- `components/ai/ask-panel.tsx`、`docx-content.tsx`、`workspace/panels/note-page` 等界面字段；它们是 UI 文本或 DOCX block，不是 `Source.text`。
- `source-summary.ts`／`summary-task-runner.ts` 中已从资料 chunks 派生出的章节对象；表格仍需按 2.2 读取原始当前版本，摘要结果自身不充当证据。

## 5. 21-2～21-8 最终接口、迁移、回滚与测试计划

### 21-2 正文读取

- 新增 `read_source_version_body(p_source_id text, p_version_id text, p_part text, p_offset integer, p_limit integer) returns jsonb`，由 `auth.uid()` 取账号，只读取当前账号 `retained` 版本。
- `meta` 返回 `{ digest, textSha256, textLength, chunkCount, status, kind }`；`text` 返回 `{ offset, text }`，`p_limit` 1–400,000；`chunks` 返回 `{ offset, chunks: [{ id, text, section, page, order }] }`，`p_limit` 1–500，按 `position` 排序。
- 新路由为 `GET /api/v1/sources/[sourceId]/versions/[versionId]/body?part=meta|text|chunks&offset=&limit=`；新建 `lib/source-body-client.ts` 的 `fetchSourceBody(userId, sourceId, versionId, signal)` 分段读取、计算 SHA-256、核对 chunkCount 和正文子串关系。

### 21-3 会话缓存

- 新建 `lib/source-body-cache.ts`：内存 `Map`，键 `${sourceId}:${versionId}`，按总字符数 LRU，上限 30,000,000 字。
- 导出 `ensureSourceBody(source, versionId?)`、`hydrateSource(source)`、`clearSourceBodies()`；已内联直接返回，同键并发请求去重，校验失败不得写缓存。
- 在账号切换、退出和释放会话内存的位置调用 `clearSourceBodies()`。本轮 21-1 不改这些调用点。

### 21-4～21-6 服务端与保存协议（人工评审后）

- 21-4 新增 authenticated `read_source_bodies_for_ai(p_refs jsonb)`（最多 10 个 source/version）和仅 `service_role` 的 `read_source_bodies_service(p_owner uuid, p_refs jsonb)`；新建 `hydrateSourcesForRequest(client, workspace, sourceIds)`，改造问答、整理、区域视觉和后台整理。
- 外置资料的 `questionContextKey` 使用 `body.digest`；内联资料保持原正文指纹。AI 关闭、版本变化、跨账号和非当前版本都拒绝补齐。
- 21-5 新增 `conuo_private.source_body_uploads`、`stage_source_body_part(...)`、`commit_source_body(...)`；单段不超过 1.5 MB，按序拼接，复用 `conuo_private.validate_version_body(...)`，配额使用 `CONUO_SOURCE_BODY_CHAR_QUOTA`，默认值按 DEC-09 为 20,000,000。
- 21-6 用新迁移替换 `conuo_private.project_workspace`；schemaVersion 接受 1 或 2；外置版本只保存 body metadata，要求数据库已有相同 `content_digest` 且元数据不可变；新增 `source_version_digests(p_refs jsonb)`。

### 21-7～21-8 客户端、移动端与回滚

- schemaVersion 2 加载时先保留外置资料元数据，实际操作调用 `ensureSourceBody`；保存时 `dehydrateForSave`，旧外置版本不重复上传，新版本先分段上传，再写 body manifest。
- 本机搜索走 `searchCloud`，阅读器、批注、选段、导出和备份恢复逐份加载正文；账号切换清空缓存。移动端合同接受 schemaVersion 1／2 和 body 后，才能允许打开开关。
- 回滚只关闭“新的外置转换”；已外置正文继续按外置 API 读取，不提供自动外置转回内联。上线顺序由人执行：迁移、服务端、客户端、staging 观察、生产。

## 6. 测试计划

每一步沿用现有 PGlite SQL 测试和 Vitest 路由／客户端测试，不访问外部网络：

1. 21-2：匿名拒绝、账号隔离、非 retained／旧版本拒绝、meta 字段、text 分段边界、chunks 排序、chunkCount 和正文子串校验。
2. 21-3：内联直返、LRU 30,000,000 字淘汰、同键并发去重、账号切换清空、校验失败不入缓存。
3. 21-4：内联与外置问答结果一致、AI 禁用资料不补齐、版本探针变化后重新补齐、服务端与 authenticated／service_role 权限隔离。
4. 21-5：分段乱序、缺段、单段超限、切块非正文子串、正文配额、重复 commit 幂等、清理不删除已引用版本。
5. 21-6：schemaVersion 1 回归、外置标记保存、digest 不匹配拒绝、元数据篡改拒绝、内外置混合、删除／换版／账号注销级联。
6. 21-7／21-8：外置工作区打开资料、批注、提问、导出、备份恢复和账号切换；移动端 schema 合同与按需读取；关闭开关后已外置资料继续可读。

## 7. 21-1 结论

当前所有资料正文／切块读取点已经按单资料、多资料、生产校验和移动端逐项归类。21-2 与 21-3 的接口边界、21-4～21-8 的迁移和回滚方案已固定，后续实现不需要重新做架构决策。按 DEC-04，提交本文件后将 WP-21 标为“待评审”，等待人类在进度表写明“WP-21 设计评审通过”后才开始 21-4；本轮不开始 21-2 或 21-3。
