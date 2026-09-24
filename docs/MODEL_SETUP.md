# 模型服务配置

Conuo 提供服务端 Chat Completions 适配器，供问答、资料整理和 PDF 区域视觉学习共用，供应商和模型由部署者配置。仓库没有内置 API 密钥，也没有默认指定某家模型服务。未填写模型连接配置时，文本问答继续使用已标注的原文检索模式，整理和区域视觉入口显示未就绪。

仓库内的自动化测试不会创建模型账号、购买额度或创建 Supabase 密钥。真实供应商兼容性、问答与整理质量、费用及云端联调仍需使用所选服务验证。

## 配置位置

本地开发使用 `apps/web/.env.local`，可从同目录 `.env.example` 复制。部署时在服务端环境变量中填写相同字段。修改后重启 Next.js 服务。

| 变量                                | 用途                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONUO_MODEL_BASE_URL`              | 供应商 API 基础地址，包含所需前缀，例如 `https://host.example/v1`。程序会追加 `/chat/completions`，不要填完整接口路径。                        |
| `CONUO_MODEL_API_KEY`               | 所选模型服务的 API 密钥，仅服务端使用。                                                                                                        |
| `CONUO_MODEL_NAME`                  | 供应商支持的实际模型标识，按其文档填写。                                                                                                       |
| `CONUO_MODEL_VISION_ENABLED`        | 默认 `false`。只有所选模型明确支持图像输入时才设为 `true`，允许发送用户主动提交的 PDF 区域截图。                                               |
| `CONUO_MODEL_JSON_MODE`             | 默认 `false`。仅确认该模型支持 JSON mode 后设置为 `true`。不接受 `1`、`yes` 等其他值。                                                         |
| `CONUO_MODEL_TOKEN_LIMIT_PARAMETER` | 输出 token 上限的字段名：`max_completion_tokens`（默认）或 `max_tokens`。仅按供应商文档选择，程序不会为同一次请求混用或重试两种字段。          |
| `CONUO_MODEL_THINKING_MODE`         | 可选、仅服务端。空值省略供应商扩展字段；`enabled`／`disabled` 发送 `thinking: {type: ...}`。仅在供应商明确支持该字段时填写，非法值会阻止调用。 |
| `CONUO_MODEL_MAX_OUTPUT_TOKENS`     | 输出 token 上限，整数 256–65536，默认 `4096`。                                                                                                  |
| `CONUO_MODEL_TIMEOUT_MS`            | 单次模型请求时限，整数 1000–600000，默认 `45000`。                                                                                              |
| `CONUO_MODEL_MAX_REQUEST_BYTES`     | 模型请求体上限，整数 65536–4194304，默认 `262144`。                                                                                             |
| `CONUO_MODEL_CONTEXT_CHARS`         | 长上下文预留字符数，整数 0–2000000，默认 `0`；WP-09 接入前不会改变上下文。                                                                      |
| `CONUO_MODEL_STREAM_USAGE`          | 默认 `false`。设为 `true` 时在流式请求中要求供应商发送最终 usage 帧，用于 AI 请求追踪；仅接受 `true`／`false`。                                |

## 模型档位

普通问答和整理使用 `default` 档位（上表的 `CONUO_MODEL_*` 变量）。轻量任务可配置 `fast`，深度问答可配置 `reasoning`，区域视觉可配置 `vision`。每个专用档位都要同时填写自己的 `BASE_URL`、`API_KEY` 和 `NAME`；其余字段沿用上表规则。专用档位未配置时，`fast` 和 `reasoning` 退回 `default`。视觉专用档位还必须设置 `CONUO_VISION_MODEL_ENABLED=true`；未配置视觉专用档位时，使用 `CONUO_MODEL_VISION_ENABLED` 和 `default` 配置的现有组合。

| 档位 | 变量前缀 | 变量 |
| --- | --- | --- |
| `fast` | `CONUO_FAST_MODEL_` | `BASE_URL`、`API_KEY`、`NAME`、`JSON_MODE`、`TOKEN_LIMIT_PARAMETER`、`THINKING_MODE`、`MAX_OUTPUT_TOKENS`、`TIMEOUT_MS`、`MAX_REQUEST_BYTES`、`CONTEXT_CHARS`、`STREAM_USAGE` |
| `reasoning` | `CONUO_REASONING_MODEL_` | `BASE_URL`、`API_KEY`、`NAME`、`JSON_MODE`、`TOKEN_LIMIT_PARAMETER`、`THINKING_MODE`、`MAX_OUTPUT_TOKENS`、`TIMEOUT_MS`、`MAX_REQUEST_BYTES`、`CONTEXT_CHARS`、`STREAM_USAGE` |
| `vision` | `CONUO_VISION_MODEL_` | `BASE_URL`、`API_KEY`、`NAME`、`JSON_MODE`、`TOKEN_LIMIT_PARAMETER`、`THINKING_MODE`、`MAX_OUTPUT_TOKENS`、`TIMEOUT_MS`、`MAX_REQUEST_BYTES`、`CONTEXT_CHARS`、`STREAM_USAGE`；另需 `CONUO_VISION_MODEL_ENABLED` |

新增数值字段的范围为：`MAX_OUTPUT_TOKENS` 256–65536（默认 4096），`TIMEOUT_MS` 1000–600000（默认 45000），`MAX_REQUEST_BYTES` 65536–4194304（默认 262144），`CONTEXT_CHARS` 0–2000000（默认 0，供长上下文功能使用）。`CONUO_ORGANIZATION_MODEL_PROFILE` 控制资料整理使用 `default` 或 `fast`，默认 `default`。

AI 请求追踪默认关闭；开启 `CONUO_FEATURE_AI_TRACES=on` 后只保存请求路由、结果、模型、检索／证据 ID、延迟和 token 计数等 metadata，服务端写入时清理 30 天前记录，不保存问题、提示词、回答或正文。
| `SUPABASE_SECRET_KEY` | 现有 Supabase 项目的服务端 secret key，用于受限的模型请求与额度账本操作。旧项目可改用 `SUPABASE_SERVICE_ROLE_KEY`，二者只填一个。 |
| `CONUO_AI_DAILY_REQUEST_LIMIT` | 每个账号每天可预占的模型请求次数，默认 `50`；允许 `1` 至 `500` 的整数，按 UTC 日期计数。 |

三个模型连接字段必须一起填写；只填一部分会明确报告配置未就绪。`CONUO_MODEL_VISION_ENABLED=true` 只是部署者的显式能力声明，不能使文本模型自动支持图片。Supabase 服务端密钥与浏览器使用的 publishable key 不同，**不能使用 `NEXT_PUBLIC_` 前缀，也不要提交 `.env.local` 或把密钥粘贴到聊天中**。普通用户身份仍通过 Supabase Auth 校验，账本所需的服务端权限不替代用户权限检查。

启用生成前，需按 [云端配置说明](CLOUD_SETUP.md) 完成 Supabase Auth、工作区和 Storage 配置，并确认 `202609120002_ai_requests.sql` 定义的账本及当前路径需要的资料索引、权限与生命周期迁移已应用。普通问答、区域视觉和显式开发页面整理不依赖尚未上线的 `organization_jobs` 持久队列；生产后台整理另需该迁移、processor 和调度器。已配置模型但缺少账本密钥或所需迁移时，云端问答会报告未就绪，不会自动降级；本机模式的原文检索和普通资料搜索仍可使用。

示例仅展示字段结构，`host.example` 和 `your-*` 均为占位内容，不能直接调用：

```dotenv
CONUO_MODEL_BASE_URL=https://host.example/v1
CONUO_MODEL_API_KEY=your-server-side-key
CONUO_MODEL_NAME=your-chosen-model
CONUO_MODEL_VISION_ENABLED=false
CONUO_MODEL_JSON_MODE=false
CONUO_MODEL_TOKEN_LIMIT_PARAMETER=max_completion_tokens
CONUO_MODEL_MAX_OUTPUT_TOKENS=4096
CONUO_MODEL_TIMEOUT_MS=45000
CONUO_MODEL_MAX_REQUEST_BYTES=262144
CONUO_MODEL_CONTEXT_CHARS=0
CONUO_MODEL_STREAM_USAGE=false
CONUO_FAST_MODEL_BASE_URL=
CONUO_FAST_MODEL_API_KEY=
CONUO_FAST_MODEL_NAME=
CONUO_FAST_MODEL_JSON_MODE=false
CONUO_FAST_MODEL_TOKEN_LIMIT_PARAMETER=max_completion_tokens
CONUO_FAST_MODEL_THINKING_MODE=
CONUO_FAST_MODEL_MAX_OUTPUT_TOKENS=4096
CONUO_FAST_MODEL_TIMEOUT_MS=45000
CONUO_FAST_MODEL_MAX_REQUEST_BYTES=262144
CONUO_FAST_MODEL_CONTEXT_CHARS=0
CONUO_FAST_MODEL_STREAM_USAGE=false
CONUO_REASONING_MODEL_BASE_URL=
CONUO_REASONING_MODEL_API_KEY=
CONUO_REASONING_MODEL_NAME=
CONUO_REASONING_MODEL_JSON_MODE=false
CONUO_REASONING_MODEL_TOKEN_LIMIT_PARAMETER=max_completion_tokens
CONUO_REASONING_MODEL_THINKING_MODE=
CONUO_REASONING_MODEL_MAX_OUTPUT_TOKENS=4096
CONUO_REASONING_MODEL_TIMEOUT_MS=45000
CONUO_REASONING_MODEL_MAX_REQUEST_BYTES=262144
CONUO_REASONING_MODEL_CONTEXT_CHARS=0
CONUO_REASONING_MODEL_STREAM_USAGE=false
CONUO_VISION_MODEL_BASE_URL=
CONUO_VISION_MODEL_API_KEY=
CONUO_VISION_MODEL_NAME=
CONUO_VISION_MODEL_ENABLED=false
CONUO_VISION_MODEL_JSON_MODE=false
CONUO_VISION_MODEL_TOKEN_LIMIT_PARAMETER=max_completion_tokens
CONUO_VISION_MODEL_THINKING_MODE=
CONUO_VISION_MODEL_MAX_OUTPUT_TOKENS=4096
CONUO_VISION_MODEL_TIMEOUT_MS=45000
CONUO_VISION_MODEL_MAX_REQUEST_BYTES=262144
CONUO_VISION_MODEL_CONTEXT_CHARS=0
CONUO_VISION_MODEL_STREAM_USAGE=false
```

### DeepSeek 配置示例

DeepSeek 当前提供 [OpenAI 兼容的 Chat Completions 接口](https://api-docs.deepseek.com/api/create-chat-completion/)，基础地址为 `https://api.deepseek.com`。Conuo 会自行追加 `/chat/completions`，因此不要填写完整接口路径。按 DeepSeek 2026-09-14 的[图像理解文档](https://api-docs.deepseek.com/zh-cn/guides/vision/)，`deepseek-flash` 已原生支持图片输入，也支持 [JSON 输出](https://api-docs.deepseek.com/guides/json_mode/)。启用 PDF 区域视觉时可使用：

```dotenv
CONUO_MODEL_BASE_URL=https://api.deepseek.com
CONUO_MODEL_API_KEY=your-deepseek-server-side-key
CONUO_MODEL_NAME=deepseek-flash
CONUO_MODEL_VISION_ENABLED=true
CONUO_MODEL_JSON_MODE=true
CONUO_MODEL_TOKEN_LIMIT_PARAMETER=max_tokens
CONUO_MODEL_THINKING_MODE=disabled
CONUO_MODEL_STREAM_USAGE=false
```

按 2026-09-15 的 [DeepSeek Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)，`deepseek-flash` 默认启用思考模式。本轮整理请求在现有 4096 token 上限出现 `length` 截断，开发配置显式使用 `disabled` 以给结构化最终结果保留预算；未提高 token 上限或加入自动重试。该模式同时用于文本、流式和图片请求，并参与请求指纹，不能把旧模式缓存当作新模式结果。其他供应商不一定支持此扩展，保持空值时维持原有请求协议。

模型能力可能随供应商变更；升级或更换模型前仍需重新核对当前文档，并保持 `CONUO_MODEL_VISION_ENABLED=true` 这一显式开关。2026-09-14 已使用当前本机配置、正式适配器和一张 105,803 字节 PNG 完成一次真实 DeepSeek 图片输入冒烟测试，模型正确描述了截图中的知识库页面。该验证只证明供应商传输与响应格式兼容。生成式问答、整理与区域视觉的登录后路由还需要服务器端 `SUPABASE_SECRET_KEY`（或旧变量 `SUPABASE_SERVICE_ROLE_KEY`）来记录次数、并发和结果；缺少它时 Conuo 会拒绝发起模型请求，不会绕过账本直接调用供应商。

外部服务必须使用 HTTPS。开发时支持 `http://localhost:端口`、`http://127.0.0.1:端口` 和 `http://[::1]:端口` 的本地模型地址；其他 HTTP 地址不接受。地址不能带用户名、密码、查询参数或片段。服务端不跟随重定向，避免把 Authorization 请求头发送到跳转目标。

## 请求协议与边界

适配器向 `POST /chat/completions` 发送 `model` 和 `system` / `user` 消息。Web 问答声明流式响应时使用 `stream: true`；资料整理与既有完整 JSON 问答路径继续使用 `stream: false`。共同参数为 `n: 1`、`store: false` 和单一输出上限字段（默认 `max_completion_tokens: 4096`；配置为 `max_tokens` 时则发送 `max_tokens: 4096`）。JSON mode 开启时额外发送 `response_format: { "type": "json_object" }`；调用方仍在提示中要求 JSON，并对返回内容进行业务结构与引用检查。字段与流格式依据 [OpenAI 官方 Chat Completions 接口文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 及[流式对象文档](https://developers.openai.com/api/reference/resources/chat)实现。Conuo 的段落展示与终态合同见[流式资料问答](STREAMING_ANSWERS.md)。

资料问答的输出合同同时禁止模型用数字、分数或百分比评价自身回答的可信度、正确率、把握度或可靠性。服务端会在流式预览和最终保存共用的绑定器中检查明确的中英文量化自评；发现后以 `INVALID_MODEL_ANSWER` 结束本次请求，不把违规段落或完整回答保存为成功结果。合同版本参与请求指纹，因此旧合同下的缓存不会绕过这项校验。该检查不替代引用人工评估，也不声称能检测所有模型幻觉。

“兼容接口”不是全部供应商或模型的兼容承诺。所选模型需接受上述字段；若供应商文档仅支持 `max_tokens`，将 `CONUO_MODEL_TOKEN_LIMIT_PARAMETER` 设为 `max_tokens`。程序不会在参数错误后自动换字段重发，以免产生重复调用费用。

每次模型调用默认最多等待 45 秒，用户停止时会取消服务端 HTTP 请求。文本请求与非流式响应正文上限均为 256 KiB；区域视觉请求正文上限为 3 MiB，其中原始图片上限为 2 MiB。上游 SSE 最多 2 MiB、8192 个数据事件，单事件最多 65,536 个 Unicode 码点，累积回答文本最多 32,000 个 UTF-16 代码单元。流式响应需要正常 `stop` 和 `[DONE]`。只接受单个完整的 assistant 文本结果；达到输出限制的截断结果、工具调用、拒答和异常结构不会作为完整回答发布。`store: false` 只是请求参数，不代表供应商不记录请求；供应商的数据保留与计费规则需另外确认。

没有自动重试。超时或取消并不能保证供应商已经停止计算或不计费；用户重新发起请求属于一次新的调用。错误信息仅返回 Conuo 的安全提示，不把供应商返回的错误正文、地址或密钥显示给浏览器。

### PDF 区域视觉请求

Web 首版只处理用户在 PDF 当前物理页明确框选的固定区域。用户可请求解读、针对区域提问或生成一次性练习；浏览器不会在拖动、预览或仅打开页面时自动调用模型。只有用户明确点击发送后，当前区域截图才作为临时图像输入传输。

区域解读使用 `vision-region-v3` 结构：新模型输出摘要及类型化小节，由服务端生成一致的 Markdown 复制内容，绑定区域身份后严格校验。前端渲染段落、列表、表格与 TeX 公式，HTML、外链、图片及受信任 TeX 命令保持禁用；文字转写仍为纯文本。旧 `content` 结果可显示，旧缓存不会被当作新合同结果。详见[区域结构与排版](REGION_STUDY.md#结构化解读与排版)。

区域结果绑定 `sourceId`、`versionId`、物理页 `page` 与相对页面宽高的归一化 `rect { x, y, width, height }`。截图字节默认不写入 IndexedDB、Supabase、Storage、资料正文、全文索引、备份或应用日志；保存的结果也不能脱离这组来源身份。供应商是否保留请求仍以其真实条款为准，`store: false` 不构成零留存承诺。

这条路径不是 OCR。它不会把截图文字写回 `Source.text` 或解析块，也不会为扫描件建立整页、全文或整库索引。扫描 PDF 的正文检索仍没有 OCR；一次区域回答不能作为整份资料已解析的依据。交互、传输和验收边界见 [PDF 区域视觉学习](REGION_STUDY.md)。

## 请求账本、次数限制与缓存

### 用户可见的请求用量

设置页“资料与 AI”提供今日已用、剩余次数和每日上限，问答、PDF 区域视觉及资料整理共用。`GET /api/v1/ai/usage` 在验证 cookie 身份、`X-Conuo-User` 和账号注销闸门后，用现有服务端账本客户端按确切账号与 UTC 日范围读取精确 HEAD 计数；返回前再次复核账号状态。它不返回请求 ID、问题、回答正文或资料信息，不预占请求，也不调用模型。响应禁止缓存，浏览器同时校验计数与日期合同。

面板显示每天 UTC 00:00 重置，并把下次重置和采样时间换算为用户本机时间；计数是采样结果，不宣称实时。打开设置、明确刷新、回到可见标签或窗口，以及本页模型请求结束时会重新读取；UTC 重置后旧日数字失效，隐藏标签不进行重置请求。账号、工作区 token 或缓存模式变化立即替换面板上下文，旧回调不发布数字。

失败、取消和超时只要已预占新请求就计入；同 ID、同指纹的缓存读取不新增次数。这里是 Conuo 的请求次数限制，不是供应商 token 消耗、费用或会员余额。降低上限后保留真实已用数，剩余不低于零。缺少账本密钥、限额配置错误、网络失败或返回格式异常时显示“用量暂不可用”，不制造零余额，也不继续显示旧数字为当前用量。用量读取不要求 AI 开关打开；但仍要求有效登录身份。

本地回归已覆盖正式 PostgREST HEAD 请求、账号和 UTC 过滤、未知计数、权限／注销闸门、上下文竞态与重置。登录后真实账本读取仍待 Supabase 服务端 secret 配置后在线验收；此功能没有新增表权限或 migration。

### 预占与结果缓存

`supabase/migrations/202609120002_ai_requests.sql` 定义服务端请求账本和原子预占函数。`/api/v1/ask` 与 `/api/v1/organize` 共用此账本和额度；每次准备调用模型前，服务端先按账号、请求 ID 与当前输入/资料指纹预占记录。每个账号同时最多一个正在运行的请求；每日默认允许预占 50 次，可通过 `CONUO_AI_DAILY_REQUEST_LIMIT` 调整为 1 至 500 次，UTC 零点开始计算新一天。

次数按已预占的新请求计算，失败、取消和超时的记录也占用次数，避免不确定的上游执行被当作免费重试。读取同一已记录请求的状态或缓存不再预占一次。这个限制是 Conuo 的调用次数保护，不是供应商费用上限，也不保证取消或超时的请求不被上游计费。

账本记录仍保留时，同一请求 ID 和同一指纹的成功请求只返回缓存；失败请求不会再次执行模型，运行中的请求返回等待提示。相同 ID 对应的问题或资料发生变化会被拒绝。缓存为空或损坏也不会被误判为需要发起新调用。用户手动重新发问时使用新的请求 ID，属于新一次调用。

清理采用按账号惰性执行：**该账号下次预占请求时**，才检查并清除预占时间超过 24 小时的缓存正文，以及超过 7 天的请求元数据。超过 2 分钟仍显示运行的记录也会在此时转为失败。目前没有定时清理任务，超过上述期限不代表数据库会立即清除内容；账号没有后续请求时，旧记录可能继续保留。

7 天元数据清理后，旧 ID 不再受现有记录的幂等保护，客户端不能把这种缓存当作永久档案，也不应复用旧 ID。2026-09-15 回读连接的 Supabase PRODUCTION，仍为 19 份已应用迁移，包含请求账本与预占／完成函数。本轮已通过真实登录请求验证账本预占与结果完成；跨实例并发、额度耗尽、缓存幂等与过期清理矩阵仍待联调，本地 mock 和结构核验不能替代线上流程验收。

## 本地验证

2026-09-15 已将现有 Supabase 项目的服务端账本密钥配置到被 Git 忽略的 `apps/web/.env.local`，没有创建新密钥或云资源。真实登录账号完成了资料生成式问答及 PDF 框选的解读、图片问答和练习生成；账本回读确认相应请求完成。资料分析返回摘要、8 个标签和 5 个主题建议，人工接受的两个标签已回读云端；两份资料生成 3 个知识主题，人工接受的切线主题保存了正文与跨两份资料的 6 个引用，刷新恢复成功。问答引用和数学答案经过人工核对，答案保存为笔记后也已回读云端记录并刷新恢复。完整结果与剩余边界见[云端验收记录](CLOUD_E2E_ACCEPTANCE.md)。这些结果证明当前开发服务连接真实 Supabase／模型的交互链路，不代表已部署 Vercel 或启用持久后台任务。

资料整理的范围、自动开关、审核与容量说明见 [ORGANIZATION.md](ORGANIZATION.md)。它使用相同模型连接配置，不额外创建模型账号或专用付费资源。自动分析默认关闭，只有云端保存已确认、全局和资料 AI 权限允许、模型就绪，并且当前 Web 构建以 `NEXT_PUBLIC_CONUO_ORGANIZATION_PROCESSOR_ENABLED=true` 声明后台 processor 已部署时，浏览器才会为整个工作区的可用资料创建自动任务。该公开变量不是密钥，也不是处理器健康检查；缺省时不会创建新的 source／knowledge 后台任务。

如果只是本地开发核对手动的资料分析或主题草稿，可在 `apps/web/.env.local` 设置 `NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED=true`。它只在 `NODE_ENV=development` 生效，生产构建始终禁用；不会启用自动分析或后台队列。用户每次点击后，现有浏览器交互链路才会发起一次请求，刷新、关闭或离开页面会中止它。此开关仍受登录、已确认同步、AI 授权、资料版本／引用复核和服务端请求账本保护；不能用于绕过 `SUPABASE_SECRET_KEY`、请求账本迁移或次数限制。详情见 [资料整理](ORGANIZATION.md#显式本地开发页面运行)。

自动任务以资料版本和保留的工作区记录避免重复执行，失败不自动重试；关闭工作台会中断浏览器调度，不是持久后台 worker。只有已声明且实际部署的 processor 才能处理成功入队的持久任务，未声明的构建保留已有记录的查看、刷新和停止操作，但不承诺关闭页面后继续。整理结果保存在 `organizationJobs` 中，标签需手动勾选、知识主题逐项审核；主题草稿生成和手动重新生成都消耗共享模型次数。账本元数据 7 天后的清理边界仍适用，不能将其描述成永久“只调用一次”。

在仓库根目录运行：

```sh
npm run test --workspace @conuo/web -- src/lib/ai/model.test.ts
npm run test --workspace @conuo/web -- src/lib/ai/requests.test.ts
npm run test --workspace @conuo/web -- src/lib/ai/requests-sql.test.ts
npm run test --workspace @conuo/web -- src/lib/ai/organization.test.ts src/lib/supabase/organize.test.ts src/lib/organization-review.test.ts src/lib/organization-runner.test.ts
```

适配器测试使用 mock fetch，并有本地真实 HTTP 流贯通用例，覆盖请求字段、配置校验、重定向、401/403/429/5xx、取消、超时、响应体卡住、超大响应、错误 JSON 与 UTF-8、分片、截断和拒答。这些测试不访问外部模型，不验证真实服务额度、价格、模型质量或 Supabase 线上规则。

账本封装测试使用 mock Supabase 客户端，覆盖服务端密钥选择、每日限制、预占与缓存状态、空缓存不重执行、RPC 错误，以及保存结果时的账号/请求/运行状态过滤和保存失败。

`requests-sql.test.ts` 在 PGlite 内存 PostgreSQL 中直接执行原始迁移，验证匿名/登录角色不能访问账本或预占函数、服务端角色操作、账号区分、UTC 日限额、缓存、失败及过期清理规则。它不连接任何真实项目，不开启端口；该测试文件全部用例结束后关闭数据库。此验证证明单连接 PostgreSQL 的 SQL 与角色权限语义，不替代 Supabase/PostgREST 联调或多实例并发锁验证。

引用校验可确认资料、版本和片段真实存在且属于当前允许范围，不等于已经验证模型每个观点都被原文支持。回答质量、冲突处理和引用支持程度仍需选定模型后，用实际样本人工抽检。

整理的 API、协调器和队列测试使用模拟模型/云端交互，审核测试直接执行领域函数。独立 Vite 浏览器夹具使用测试结果验证实际整理面板和审核交互，不代表真实供应商或 Supabase 端到端通过。最终测试与运行记录见 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)。
