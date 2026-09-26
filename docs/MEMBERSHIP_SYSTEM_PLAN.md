# Conuo 会员系统方案（支付未接入）

状态：方案 v2，阶段 A 与 B0 已实现，生产数据库已应用迁移，待决定第 13 节问题  
范围：账户级会员、会员权益、管理员数据库操作、未来支付预留  
当前阶段：阶段 A（数据库基础）与 B0（服务端影子接入代码）已实现，见 §14；B1 及之后尚未开始

## 0. 本版修订摘要

v1 草稿对照现有迁移和服务端代码评审后，主要调整如下：

1. 当前会员由“每账号一行、upsert 覆盖”改为**授权流水**（`membership_grants`）：每次开通、赠送、付款各记一行，解析时取当前有效且等级最高的一条。旧写法中赠送会覆盖永久或付费授权、赠送到期后直接掉回免费版的问题由此消除。授权表本身即审计记录，不再单独建 `membership_change_log`。
2. 会员额度只在**数据库中的单一解析函数**计算。AI 预占 RPC、用量接口、`save_workspace` 和界面 RPC 都调用它，服务端不再把每日额度作为参数传给账本。
3. **Token 额度第一版不按会员分档**。现有 Token 统计依赖默认关闭、尽力写入的追踪表，且学习、术语建议、查询改写、OCR、摘要等调用不计入。按会员分 Token 列为独立的前置工作（§8.5）。
4. 补齐现有 5 项按账号每日额度、存储上限和单并发的处理决定（§2.2、§4.2）。
5. 学习空间上限明确在 `save_workspace` 中执行，只拒绝“新增活跃空间且超出上限”的保存，降级不阻止保存已有内容（§8.3）。
6. 功能开关与现有部署开关叠加，拆开“学习（非 AI）”和“学习 AI”，界面改为读取运行时权益（§8.2）。
7. 管理操作改为必须填写操作人和原因的数据库函数，只允许 SQL Editor（`postgres`）调用，不授予 `service_role`（§5.5、§7、§9）。
8. 上线分为影子运行和正式执行两步，并处理现有账号额度被收紧的问题（§11）。

## 1. 目标与边界

Conuo 先建立一套由数据库驱动的会员等级和权益模型。管理员可以在数据库中为某个账号授予指定等级，服务端和数据库根据解析出的有效等级决定 AI 额度、学习空间数量和功能权限。

本阶段不接支付，不接支付回调，不创建支付客户，不保存银行卡或支付凭据。会员变化通过数据库管理函数完成，后续支付系统只作为另一种授权来源。

会员按账户生效。当前每个账号只有一行 `public.workspaces`（`owner_id` 主键），学习空间是快照中的 `spaces` 数组，AI 请求也以 `owner_id` 记账。因此会员等级作用于该账号下的全部学习空间，Web、桌面和 iOS/iPadOS 客户端共享同一权益。

本方案不把会员信息写入 `auth.users.raw_user_meta_data`，也不让浏览器提交会员等级、额度或开关。数据库中的授权记录和解析函数的结果是唯一权限来源。

降级只限制**新的** AI 生成和新增活跃学习空间，不限制读取、编辑、搜索、导出已有资料，也不限制访问已生成的 AI 结果、学习卡片和复习队列。

## 2. 与当前系统的衔接

### 2.1 现有边界

- 身份来自 Supabase Auth。账号删除最终由受保护的 worker 调用 `auth.admin.deleteUser`，依赖 `on delete cascade` 清理账号数据。`public.account_deletions` 有意不设指向 `auth.users` 的外键，以便级联删除后仍保留注销记录。
- 当前没有应用内管理员身份。人工操作在 Supabase SQL Editor 中以 `postgres` 角色执行，此时 `auth.uid()` 为空，无法自动得知操作人。
- 服务端私有账本的惯例是放在 `conuo_private`，对 `anon`、`authenticated`、`service_role` 全部 revoke，只通过 RPC 访问（如 `ocr_usage`、`ai_request_traces`）。
- `save_workspace` 直接授予 `authenticated`，浏览器可以绕过 `/api/v1/workspace` 直接调用。任何针对工作区快照的限制都必须在数据库中执行。
- 新账号的空工作区自带一个“我的学习空间”（`apps/web/src/lib/seed.ts`）；快照投影最多允许 500 个空间。
- AI 请求统一进入 `public.ai_requests`，由 `reserve_ai_request` 在按账号的 advisory lock 中处理幂等、单并发和每日次数：
  - 每个账号同时只允许 1 个运行中的请求，后台整理任务也占用这个名额；
  - 失败、取消、超时的请求同样计入当日次数；
  - 相同请求 ID 和指纹的重放直接返回已保存结果，不新增次数。
- 服务端功能开关为 `CONUO_FEATURE_*`；部分界面的可见性由构建期的 `NEXT_PUBLIC_CONUO_FEATURE_*` 决定，无法按用户变化。
- 所有学习路由（包括不调用模型的 `items`、`queue`、`reviews`、`settings`、`overview`）共用 `requireLearningFeature()`。

### 2.2 现有按账号每日额度

所有额度都按 UTC 日计算，数值来自部署级环境变量，由服务端作为参数传给对应 RPC：

| 额度 | 环境变量与默认值 | 执行位置 | 覆盖的调用 |
| --- | --- | --- | --- |
| AI 请求次数 | `CONUO_AI_DAILY_REQUEST_LIMIT`=50（1–500） | `reserve_ai_request` | 问答、整理、区域视觉、学习 AI、术语建议、后台整理任务 |
| AI Token | `CONUO_AI_DAILY_TOKEN_LIMIT`=0（关闭，最大 1 亿） | `reserve_ai_request` + `ai_token_usage_today` | 汇总请求账本和 OCR／摘要的 Token-only 账本，见 §2.3 |
| OCR 页数 | `CONUO_OCR_DAILY_PAGE_LIMIT`=100（1–2000） | `reserve_ocr_pages` | 扫描页转写；不占 AI 请求次数 |
| 向量化字符 | `CONUO_EMBEDDING_DAILY_CHAR_LIMIT`=200,000 | `reserve_embedding_usage` | 资料向量化 |
| 章节摘要 | `CONUO_SUMMARY_DAILY_SECTION_LIMIT`=60（1–500） | `reserve_summary_section` | 章节摘要任务 |

另有单文件 30 MiB、每账号原件 512 MiB、工作区快照 3 MiB 等安全上限。现有文档已说明它们不是对外套餐承诺，本方案继续把它们作为全局安全上限。

### 2.3 Token 统计现状

阶段 T 已把 `ai_token_usage_today` 改为汇总 `public.ai_requests` 的请求列，以及 OCR／章节摘要使用的私有 Token-only 账本，不再读取可选的 `conuo_private.ai_request_traces`：

- `ai_requests.prompt_tokens` 与 `completion_tokens` 由新的六参数 `finish_ai_request` 累加；查询改写、主回答和回答校验等同一请求 ID 下的多次模型调用合并计算，旧四参数签名仍可用。
- 所有文本、视觉、学习、整理和术语模型调用经过统一用量回调。供应商没有返回字段时按请求／结果字符数使用固定的有界近似值，避免关闭 `CONUO_FEATURE_AI_TRACES` 使 Token 上限失效。
- OCR 和章节摘要没有请求次数账本记录，改写入 `conuo_private.ai_token_usage_ledger`；统计和权限仍只由服务端函数提供。
- `CONUO_AI_DAILY_TOKEN_LIMIT` 仍是全局上限，不作为会员等级权益；会员分档和两周数据标定继续留待产品决定。

## 3. 设计原则

1. **单一解析点**：有效会员只由 `conuo_private.effective_membership()` 计算。所有执行额度和开关的地方都调用它，不在 TypeScript 中重复实现。
2. **授权只追加，不覆盖**：新授权新增一行；更正或降级通过撤销旧授权完成。
3. **出错即拒绝**：解析失败、`free` 等级缺失或配置异常时，拒绝新的 AI 请求（沿用现有 503），不回退到环境变量，也不降级为无账本调用。
4. **部署开关与会员开关叠加**：功能可用 = 部署开关开启 且 会员开关开启。部署层关闭的功能不会因为会员等级而开启。
5. **环境变量变为全局上限**：正式执行后，有效次数 = min(会员额度, 全局上限)。全局上限只用于紧急止损，不再代表普通用户的额度。
6. **降级不扣押数据**：降级不阻止读取和保存已有内容，只限制新增。
7. **配置走迁移，授权走函数**：等级数值和开关只通过版本化迁移修改，保留 Git 记录；给账号授权只通过管理函数。

## 4. 会员分层

### 4.1 等级与数值

下面的数值是可调整的初始建议，不是已承诺的商业价格或最终 PRD。

| 等级 | 代码 | 每日 AI 请求 | 活跃学习空间 | 定位 |
| --- | --- | ---: | ---: | --- |
| 免费版 | `free` | 20 | 1 | 阅读、搜索、基础 AI 体验 |
| 专业版 | `pro` | 100 | 5 | 高频学习、资料整理、学习 AI |
| 旗舰版 | `max` | 300 | 20 | 重度使用和更高额度 |

说明：

- 每日 AI 请求上限受现有账本范围约束，必须在 1–500 之间。
- 区域视觉第一版**共用**每日 AI 请求次数，界面不展示单独的视觉额度。若产品要求第一版就有独立视觉额度，需要先按 `ai_requests.route` 独立计数再展示（§8.1）。
- 草稿中的 Token 目标值（5 万 / 30 万 / 100 万）暂不写入等级表。按这组数值，免费版平均每次请求只有约 2,500 Token，而单次输出上限就是 4,096，真正先耗尽的会是 Token 而不是次数。应在 §8.5 完成后，按 [AI_ENHANCEMENT_PLAN.md](AI_ENHANCEMENT_PLAN.md) 中“追踪满两周后按账号日用量 P95 设定”的方法重新标定。
- 这些数值低于现有部署默认值（请求 50 次、Token 不限、空间最多 500 个），上线会收紧现有账号，处理方式见 §11。

### 4.2 各项额度在第一版的处理

| 额度 | 第一版 | 说明 |
| --- | --- | --- |
| AI 请求次数 | 按会员 | 由新的预占 RPC 解析 |
| AI Token | 保持全局 | 沿用 `CONUO_AI_DAILY_TOKEN_LIMIT`；按会员分档依赖 §8.5 |
| 区域视觉 | 共用请求次数 | 开始记录 `route`，暂不单独限额 |
| OCR 页数 | 保持全局，所有等级相同 | 部署启用视觉模型后所有用户都已可用，第一版不收回 |
| 向量化字符 | 保持全局 | — |
| 章节摘要 | 保持全局 | — |
| 学习空间 | 按会员 | 在 `save_workspace` 中执行，只统计未归档空间 |
| 存储与单文件 | 保持全局安全上限 | 不作为会员权益宣传 |
| 并发 | 所有等级都是 1 | 后台任务同样占用；是否对高等级放宽见 §13 |

### 4.3 功能开关

`features` 只允许以下键，值为布尔，缺失视为 `false`：

| 键 | 覆盖的服务端入口 | 叠加的部署条件 | 免费版 | 专业版 | 旗舰版 |
| --- | --- | --- | --- | --- | --- |
| `vision_region` | `/api/v1/vision/region-study`（全部任务） | 已配置视觉模型 | 开 | 开 | 开 |
| `organization` | `/api/v1/organize`、后台整理任务、术语建议 | — | 开 | 开 | 开 |
| `learning_ai` | 学习的 `generate`、`grade`、`hint`、`explain-feedback` | `CONUO_FEATURE_LEARNING` | 开 | 开 | 开 |
| `deep_thinking` | 问答深度思考 | `CONUO_FEATURE_DEEP_THINKING` | 开 | 开 | 开 |
| `tutor_mode` | 问答导师模式 | `CONUO_FEATURE_TUTOR_MODE` | 开 | 开 | 开 |

第一版各等级的功能开关与现状一致，等级差异只体现在请求次数和学习空间数。开关机制先建好；是否把深度思考、导师模式等设为付费能力由 §13 决定，届时只需一份迁移修改等级配置。

以下内容不进入 `features`，所有等级始终可用：阅读、搜索、笔记、导出、普通 AI 问答（受请求次数限制），以及学习卡片与复习队列中不调用模型的部分。

“高级模型或优先队列”“API 访问”在对应路由或模型路由实现之前不加键，也不在界面承诺。

## 5. 数据模型

以下均为实现草案。落地时新增版本化迁移，不修改已应用的迁移；需要替换现有函数时沿用仓库惯例，在新迁移中复制最新定义并注明改动。

### 5.1 `public.membership_plans`

保存等级配置，只通过迁移修改。

| 字段 | 类型 | 约束与说明 |
| --- | --- | --- |
| `code` | `text` 主键 | 小写字母、数字和连字符，如 `free`、`pro`、`max` |
| `name` | `text` | 用户看到的名称 |
| `description` | `text` | 会员说明 |
| `tier_rank` | `smallint` 唯一 | 等级高低，解析时取最高者；`free` 最低 |
| `display_order` | `smallint` | 仅用于展示顺序 |
| `is_public` | `boolean` | 是否对登录用户展示；内部测试档设为 `false` |
| `is_grantable` | `boolean` | 是否允许新增授权；设为 `false` 后已有授权继续有效 |
| `ai_daily_request_limit` | `integer` | `CHECK (between 1 and 500)`，与账本范围一致 |
| `learning_space_limit` | `integer` | `CHECK (between 1 and 500)`，只统计未归档空间 |
| `features` | `jsonb` | `CHECK`：必须是对象，键在 §4.3 白名单内，值为布尔 |
| `created_at` / `updated_at` | `timestamptz` | — |

- `free` 不能删除，也不能修改其 `code`，用触发器保证。
- 不设价格、币种和计费周期字段。一个等级可能同时有月付和年付，价格在阶段 D 单独建表（§10）。
- 不设 `ai_daily_token_limit`、`vision_daily_limit`。未执行的配置不入库，避免界面显示了额度而服务端没有计数。对应能力就绪时再用迁移添加。
- 阶段 A 初始化时，三档的 `learning_space_limit` 都先设为 500（等于现状），到阶段 B1 再用迁移改为目标值。这样空间上限的执行代码可以提前上线，但不改变行为。

### 5.2 `conuo_private.membership_grants`

每次授权一行，表本身就是审计记录。

| 字段 | 类型 | 约束与说明 |
| --- | --- | --- |
| `grant_id` | `uuid` 主键 | 默认 `gen_random_uuid()` |
| `owner_id` | `uuid` | 引用 `auth.users(id) on delete cascade` |
| `plan_code` | `text` | 引用 `membership_plans(code)` |
| `source` | `text` | `manual`、`promotion`、`trial`、`system`、`payment`（`payment` 只在阶段 D 使用） |
| `starts_at` | `timestamptz` | 生效时间，可以在未来 |
| `ends_at` | `timestamptz null` | 到期时间；为空表示长期授权 |
| `actor` | `text` | 操作人标识（如管理员邮箱或 `system:migration`），1–200 字符，必填 |
| `note` | `text` | 原因或工单号，1–1000 字符，必填；不存支付敏感信息 |
| `external_ref` | `text null` 唯一 | 预留给支付订阅或事件 ID |
| `revoked_at` | `timestamptz null` | 撤销时间 |
| `revoked_by` | `text null` | 撤销操作人 |
| `revoke_reason` | `text null` | 撤销原因 |
| `created_at` | `timestamptz` | 记录时间 |

约束：

- `ends_at is null or ends_at > starts_at`。
- `source in ('promotion','trial')` 时 `ends_at` 必填。
- `revoked_at`、`revoked_by`、`revoke_reason` 同时为空或同时有值。
- 触发器只允许把撤销字段从空改为有值，其余字段不可修改；更正方式是“撤销错误授权 + 新增正确授权”。
- 不授予任何角色 DELETE。账号删除由外键级联清理。表上**不建**“删除时向其他表写记录”的触发器，避免在注销级联中插入引用已删除账号的行，导致注销失败。
- 索引：`(owner_id, starts_at)`，以及 `revoked_at is null` 的部分索引。
- `revoke all ... from public, anon, authenticated, service_role`。

### 5.3 解析函数 `conuo_private.effective_membership(p_owner uuid, p_at timestamptz default now())`

返回 `jsonb`，是全系统唯一的会员解析逻辑：

```sql
-- 伪代码
select g.*, p.*
from conuo_private.membership_grants g
join public.membership_plans p on p.code = g.plan_code
where g.owner_id = p_owner
  and g.revoked_at is null
  and g.starts_at <= p_at
  and (g.ends_at is null or g.ends_at > p_at)
order by p.tier_rank desc, g.ends_at desc nulls first, g.created_at desc
limit 1;
-- 没有有效授权时返回 free；free 不存在时抛出异常（出错即拒绝）
```

返回内容：

- `planCode`、`planName`、`tierRank`；
- `source`、`grantId`、`startsAt`、`endsAt`：取自生效的那条授权，免费版为空；
- `limits.aiDailyRequests`、`limits.learningSpaces`；
- `features`：等级配置中的开关，尚未叠加部署开关；
- 可选的 `afterEnd`：在 `endsAt` 时刻重新解析得到的等级代码，供界面显示“到期后回到 X”。

`is_grantable = false` 的等级不影响已有授权的解析。

### 5.4 对外 RPC

| 函数 | 调用方 | 作用 |
| --- | --- | --- |
| `public.my_membership()` | `authenticated` | 按 `auth.uid()` 返回解析结果，并先检查注销状态；界面只通过它读取会员，不直接查询授权表 |
| `public.resolve_membership(p_owner uuid)` | `service_role` | 只读；供服务端判断深度思考等请求形态 |
| `public.reserve_membership_ai_request(...)` | `service_role` | 新的 AI 预占，见 §8.1 |
| `public.ai_membership_usage(p_owner, p_global_cap, p_enforcement)` | `service_role` | 供用量接口使用，与预占用同一套规则计算有效额度 |

### 5.5 管理函数

管理函数都放在 `conuo_private`，对 `public`、`anon`、`authenticated`、`service_role` 全部 revoke，只有 `postgres`（SQL Editor）能执行。这样即使服务端密钥泄露，也无法给账号自助升级。

- `conuo_private.grant_membership(p_owner, p_plan, p_source, p_starts_at, p_ends_at, p_actor, p_note)`：返回 `grant_id`。它会校验：
  - 账号存在，且不在注销流程中；
  - 等级存在且 `is_grantable`；
  - `source` 不是 `payment`；
  - `ends_at` 晚于当前时间；
  - `actor`、`note` 非空。
- `conuo_private.revoke_membership_grant(p_grant_id, p_actor, p_reason)`：撤销单条授权。
- `conuo_private.revoke_active_memberships(p_owner, p_actor, p_reason)`：撤销该账号当前和未来生效的全部非 `payment` 授权，即“降回免费版”。

## 6. 会员状态规则

1. 未撤销、已开始、未到期的授权为有效授权。
2. 多条授权同时有效时，取 `tier_rank` 最高的一条；同一等级取到期最晚的一条。
3. 授权到期后，自动回落到下一条有效授权；没有则为免费版。回落在解析时发生，不需要定时任务修改状态。
4. 长期授权（`ends_at` 为空）只用于 `manual` 和 `system` 来源，并且必须写明原因；活动赠送和试用必须有到期时间。
5. 升级立即生效，当天已用的请求次数不清零。
6. 降级立即生效。当天已用次数不低于新额度时，剩余为零，下一个 UTC 日重新计算。这与现有账本“已用 ≥ 额度即拒绝”的行为一致。
7. 已完成请求的重放（相同请求 ID 和指纹）在降级后仍返回已保存结果，不重新检查额度和开关。
8. 后台任务在**执行时**按当时的会员解析，而不是按入队时。
9. 每日额度沿用 UTC 日期窗口，即北京时间 08:00 重置，与现有 5 个账本一致。计数在服务端进行，不受客户端时区影响。是否改为固定的 `Asia/Shanghai` 见 §13；如需修改，5 个账本和界面文案必须一起改。

## 7. 管理员数据库操作

以下示例在对应表和函数建立之前不能执行。不要对 `membership_grants` 直接执行 `insert`、`update` 或 `delete`。`postgres` 技术上能绕过函数，但函数负责字段校验，并保证操作人和原因不为空。

### 查询账号 UUID

```sql
select id, email
from auth.users
where email = 'user@example.com';
```

### 查看当前会员和授权历史

```sql
select conuo_private.effective_membership('USER_UUID');

select grant_id, plan_code, source, starts_at, ends_at,
       actor, note, revoked_at, revoked_by, revoke_reason, created_at
from conuo_private.membership_grants
where owner_id = 'USER_UUID'
order by created_at desc;
```

### 开通专业版（长期）

```sql
select conuo_private.grant_membership(
  p_owner     => 'USER_UUID',
  p_plan      => 'pro',
  p_source    => 'manual',
  p_starts_at => now(),
  p_ends_at   => null,
  p_actor     => 'admin@example.com',
  p_note      => '工单 #123：管理员手动开通'
);
```

### 活动赠送 30 天

原有授权不受影响：赠送等级更高时，赠送期间按赠送等级计算，到期后自动回到原有授权。

```sql
select conuo_private.grant_membership(
  p_owner     => 'USER_UUID',
  p_plan      => 'pro',
  p_source    => 'promotion',
  p_starts_at => now(),
  p_ends_at   => now() + interval '30 days',
  p_actor     => 'admin@example.com',
  p_note      => '2026 秋季活动赠送'
);
```

### 降回免费版

```sql
select conuo_private.revoke_active_memberships(
  p_owner  => 'USER_UUID',
  p_actor  => 'admin@example.com',
  p_reason => '工单 #456：管理员降级'
);
```

### 更正错误授权

```sql
select conuo_private.revoke_membership_grant(
  p_grant_id => 'GRANT_UUID',
  p_actor    => 'admin@example.com',
  p_reason   => '等级填错，已按正确等级重新授权'
);
-- 然后按正确参数再调用一次 grant_membership
```

## 8. 权益接入

### 8.1 AI 请求次数

新增 `public.reserve_membership_ai_request(p_owner, p_request_id, p_fingerprint, p_route, p_features, p_global_cap, p_enforcement, p_ttl_seconds, p_daily_token_limit)`。`p_features` 是 `text[]`，一次请求可能同时需要多个开关（如深度思考加导师模式），必须全部开启。使用独立的函数名，避免与现有 `reserve_ai_request` 的多个重载混淆；旧签名在全部路由切换后，由后续迁移删除。

行为：

1. 参数校验：
   - `p_route` 取 `ask`、`organize`、`organization-job`、`vision`、`learning`、`glossary` 之一；
   - `p_features` 为空，或最多 5 个且都属于 §4.3 的白名单；
   - `p_global_cap` 在 1–500 之间；
   - `p_enforcement` 为 `off`、`shadow`、`on` 之一。
2. 执行 `assert_account_access`，并使用与现有 `reserve_ai_request` **相同**的 advisory lock 键，保证过渡期内新旧函数仍按账号串行。
3. 沿用现有的超时回收、结果过期和 7 天清理逻辑。
4. 先查询同一请求 ID。已存在时按现有规则返回（已保存结果、`mismatch`、`failed`），不检查额度和开关。
5. 存在运行中的请求时返回 `busy`。
6. 调用 `effective_membership(p_owner)`，再按执行模式处理：
   - `off`：额度 = `p_global_cap`，不检查开关，与现状相同；
   - `shadow`：额度 = `p_global_cap`，不拦截。返回值中附带 `planCode`、`planLimit`、`wouldLimit`、`featureAllowed`，服务端据此写入不含用户正文的结构化日志；
   - `on`：`p_features` 中任一开关未开启时返回 `feature_unavailable`，不插入记录、不消耗次数；额度 = min(会员额度, `p_global_cap`)。
7. 统计当日次数，达到额度时返回 `limited`；Token 检查沿用现有的全局逻辑。
8. 插入记录时写入新增的 `ai_requests.route` 列（可空，旧记录为空）。第一版只用于分析，将来的独立视觉额度按它计数。

服务端变化：

- 新增 `CONUO_MEMBERSHIP_ENFORCEMENT`，取值 `off`、`shadow`、`on`，默认 `off`。
- `CONUO_AI_DAILY_REQUEST_LIMIT` 作为 `p_global_cap` 传入。切到 `on` 时应设为 500，否则会把高等级的额度压低。`.env.example` 和 [MODEL_SETUP.md](MODEL_SETUP.md) 中的变量说明要同步修改。
- `feature_unavailable` 映射为 403 `MEMBERSHIP_FEATURE_REQUIRED`；`limited` 保持 429 `AI_DAILY_LIMIT`。
- `/api/v1/ai/usage` 改用 `ai_membership_usage`，返回值增加会员信息。`aiRequestUsageSchema` 是严格 schema，服务端和界面需要同步修改。
- 所有调用 `reserveRequest` 的路由一起切换：问答、整理、区域视觉、学习的四个生成类路由、术语建议、后台整理任务。

### 8.2 功能开关

- 服务端：各路由把需要的开关通过 `p_features` 传给预占 RPC，由数据库在消耗次数之前判断。问答在请求深度思考或导师模式时分别带上 `deep_thinking`、`tutor_mode`；会员未开启时返回 403，不静默降级为标准模式。
- 学习：`requireLearningFeature()` 继续只代表部署开关，覆盖全部学习路由。`learning_ai` 只加在 `generate`、`grade`、`hint`、`explain-feedback` 上，降级用户仍能打开卡片、复习队列和学习设置。
- 界面：新增 `GET /api/v1/account/membership`，Web 与 iOS/iPadOS 共用，返回 `my_membership()` 与部署开关叠加后的最终结果。`NEXT_PUBLIC_CONUO_FEATURE_*` 仍只代表部署层是否可见；最终可见 = 部署层可见 且 会员开启。会员未开启的功能直接显示为不可用并说明原因，而不是点击后才报错。

### 8.3 学习空间上限

在新迁移中复制最新的 `save_workspace` 定义，在拿到账号锁并读取旧快照之后增加检查：

- 活跃空间数 = `spaces` 中 `archived = false` 的数量。首次保存（`p_expected_revision = 0`）时，旧数量按 0 计算。
- 只有同时满足“新活跃空间数 > 旧活跃空间数”和“新活跃空间数 > 会员上限”时才拒绝保存；取消归档也算增加。数量不变或减少的保存始终放行，因此降级后仍能正常编辑已有空间。
- 拒绝时使用 `errcode = 'PT403'`（PostgREST 会映射为 HTTP 403，仓库已有 `PT409` 的先例）。`/api/v1/workspace` 把它映射为 `LEARNING_SPACE_LIMIT`，不与 `Invalid workspace payload` 混用。
- 新账号自带的“我的学习空间”计为 1 个。免费版上限为 1 时，要新建空间需先归档已有空间。
- 客户端在新建空间或取消归档之前，按权益接口先做检查；保存被拒时沿用现有的未保存内容保护机制，不丢失输入。
- 备份恢复和导入：超出上限的空间在保存前转为归档，并提示用户，不能让整次恢复失败。
- 归档空间不参与 AI，存储也另有全局上限，所以第一版只限制活跃空间数。如果产品要限制全部空间的总数，见 §13。

### 8.4 后台任务

- 后台整理任务通过新的预占 RPC 按 `owner_id` 解析会员，不需要登录会话。执行时若对应开关（如 `organization`、`learning_ai`）已关闭，任务以不可重试的 `MEMBERSHIP_FEATURE_REQUIRED` 结束；额度用尽（429）仍按现有逻辑重试。
- 章节摘要和向量化第一版不按会员区分，继续使用各自的全局额度。
- 并发：所有等级仍然是每账号 1 个运行中请求，后台任务同样占用。后台任务运行时交互请求会收到 `REQUEST_RUNNING`，这是现有行为，第一版不改。

### 8.5 按会员分 Token 的前置工作（独立推进）

满足以下条件后，再用迁移给等级表增加 `ai_daily_token_limit`（`integer`，0–100,000,000，与现有 RPC 的参数类型一致）：

1. ✅ `20260927000200_ai_request_token_ledger.sql` 已把 Token 用量写进账本：`finish_ai_request` 同时记录 prompt 和 completion 用量，同一请求 ID 下的多次模型调用（查询改写、主回答、校验）合并计算；旧四参数签名继续可用。
2. ✅ 所有模型调用都经过统一计量回调，包括学习、术语建议、查询改写、OCR 转写和章节摘要；供应商不返回用量时按固定字符近似策略补齐，OCR／摘要使用 Token-only 账本。
3. 收集两周数据，按账号日用量 P95 标定各等级数值，并核对“请求次数 × 单次典型用量”与 Token 上限的比例；本阶段不做数值标定。

当前 Token 只保留全局上限，界面继续标注“近似”，不作为会员权益展示。

## 9. RLS 和访问边界

- `public.membership_plans`：启用 RLS，`authenticated` 只能读取 `is_public = true` 的行；`anon`、`authenticated`、`service_role` 都没有写权限。
- `conuo_private.membership_grants`：对 `public`、`anon`、`authenticated`、`service_role` 全部 revoke，不通过 Data API 暴露。
- `public.my_membership()` 只返回当前登录账号的解析结果，并检查注销状态，与现有的 `account_deletion_access_allowed()` 保持一致。
- `public.resolve_membership()`、`public.reserve_membership_ai_request()`、`public.ai_membership_usage()` 只授予 `service_role`。
- 管理函数只有 `postgres` 可以执行。
- `auth.users` 的邮箱只用于管理员查询，不复制到会员表。
- 账号删除时，授权记录随 `auth.users` 级联删除。第一版的注销预览不变；阶段 D 再增加有效付费订阅的提示。
- 任何服务端管理密钥都不进入 `NEXT_PUBLIC_*` 环境变量。

## 10. 未来支付预留

支付接入时新增独立的账单表，不把支付平台字段和会员权益逻辑混在一起：

- `membership_prices`：等级、计费周期、币种、金额（以最小货币单位记）、支付平台的价格 ID、是否可售。
- 支付客户与订阅：支付平台、客户 ID、订阅 ID、当前周期起止时间、是否在周期结束时取消、平台状态、最后一次事件时间。
- 支付事件：`(provider, event_id)` 唯一，保证重复和乱序的回调只处理一次。
- 保留期限：财务记录的保留期由法务确认，可能长于账号数据。需要保留的记录参照 `account_deletions` 的做法，不设指向 `auth.users` 的级联外键，或者做去标识化处理。

权益衔接：

- 已验证的回调只调用一个用途单一的函数（例如 `apply_payment_entitlement`，只授予 `service_role`）。它负责新增、延长或撤销 `source = 'payment'` 的授权，用 `external_ref` 记录订阅 ID，并且必须幂等。AI 路由继续只读会员解析结果，不直接判断支付平台的返回值。
- 退款或订阅取消通过撤销对应授权完成，同时存在的赠送授权不受影响。
- 同一账号可能同时有 iOS 内购和 Web 订阅，授权流水可以同时表示两者。
- iOS/iPadOS 应用内销售数字订阅受 App Store 规则约束。阶段 C 的升级入口先只放在 Web，iOS 应用内不放指向站外支付的按钮。
- 有有效付费订阅的账号申请注销时，先提示用户。Apple 订阅无法由服务端取消，需要引导用户自行取消。
- 国内自动续费有提前提醒、便捷取消等监管要求，上线前由法务确认。

支付接入前不创建支付客户、不保存支付密钥、不增加支付 webhook。

## 11. 分阶段实施

### 阶段 A：数据库基础（不改变任何现有行为）

- 新增等级表（写入 `free`、`pro`、`max`，学习空间上限先都设为 500）、授权表、解析函数、`my_membership`、`resolve_membership` 和管理函数。
- 给 `ai_requests` 增加可空的 `route` 列。
- 新增 `reserve_membership_ai_request` 和 `ai_membership_usage`，此时还没有路由调用它们。
- 迁移依赖 `20260926000200_ai_token_usage.sql` 及之前的全部迁移；在目标环境按顺序应用，先 staging 后 production。
- 按现有的 PGlite 模式新增 SQL 测试，参考 `apps/web/src/lib/supabase/ai-token-usage-sql.test.ts`。

### 阶段 B0：影子运行

- 服务端所有路由切换到新的预占 RPC，设置 `CONUO_MEMBERSHIP_ENFORCEMENT=shadow`。
- 用量接口开始返回会员信息，但实际限制仍是全局值。
- 观察至少一周的“本会被拒绝”日志，据此校准数值。

### 阶段 B1：正式执行

- 处理现有账号：建议用一次性运维 SQL，为上线前已注册的账号新增 `source = 'system'` 的授权（等级和到期时间由产品决定）。否则这些账号会立刻从每天 50 次、最多 500 个空间收紧到免费版。
- 用迁移把学习空间上限改为目标值（1 / 5 / 20），`save_workspace` 中的检查随之生效。
- 设置 `CONUO_AI_DAILY_REQUEST_LIMIT=500`、`CONUO_MEMBERSHIP_ENFORCEMENT=on`。
- 回滚方式：把执行模式切回 `shadow`；空间上限用迁移改回 500。

### 阶段 C：产品展示

- 新增 `/api/v1/account/membership`，界面按最终权益控制功能的可见性和可用性。
- 设置页显示当前等级、来源、到期时间、到期后的等级和今日用量，并用本地时间显示重置时刻。
- Web 显示升级入口，但支付按钮处于“暂未开放”状态；iOS/iPadOS 不显示升级入口。

### 阶段 T：Token 计量（与阶段 B、C 并行）

- 完成 §8.5 后，再把 Token 纳入会员分档。

### 阶段 D：支付

- 单独确定价格、退款、试用、续费、取消和支付失败的规则。
- 按 §10 建表和实现回调函数。
- 先在 staging 验证重复回调、乱序回调、过期订阅、退款，以及付费授权与赠送授权的叠加。

## 12. 验收清单

数据库层：

- 没有授权记录的账号解析为免费版；`free` 缺失时解析抛错，预占被拒绝。
- 不存在的等级、不可授予的等级、缺少操作人或原因的授权都无法写入。
- 永久 `max` 账号再获得 30 天 `pro` 赠送后仍是 `max`；`pro` 账号获得 7 天 `max` 赠送，到期后回到 `pro`。
- 未来生效的授权在生效之前不影响当前等级。
- 授权到期或被撤销后，不需要任何任务就能自动回落。
- 授权记录只能撤销，不能修改其他字段；`authenticated`、`anon`、`service_role` 无法读写授权表，也无法调用管理函数。
- 有授权记录的账号能完整走完注销流程，注销后不留下可被其他账号读取的会员数据。

服务端层：

- 客户端不能伪造会员等级、额度或开关；服务端也无法把额度提高到会员额度以上。
- 设置页显示的额度与预占实际使用的额度来自同一个函数。
- 同一账号的多个标签页和多台设备共享同一份额度。
- 当天升级、降级、到期的额度规则与 §6 一致；降级后已完成请求的重放仍然可用。
- 会员未开启的功能返回 403，并且不消耗次数。
- `off` 模式下的行为与现状完全一致；`shadow` 模式不拦截任何请求。
- 后台整理任务在执行时按当时的会员判断。
- AI 路由配置或会员解析出现异常时拒绝请求，不降级为无账本调用。

学习空间：

- 直接调用 `save_workspace` 也无法新增超出上限的活跃空间，取消归档同样受限。
- 降级后空间数超过上限的账号，仍能保存笔记和编辑已有空间。
- 把备份恢复到免费账号时，超出的空间转为归档，恢复本身不失败。

产品层：

- 用户能看到当前等级、到期时间和剩余次数；过期后界面显示与实际权限一致。
- 降级后，已有的 AI 结果、学习卡片和复习队列仍可访问。
- 未接支付时，不出现“已付款”“自动续费”等文案；iOS/iPadOS 不出现付费升级入口。

## 13. 待评审问题

已根据现有代码评审确定：

- 会员按账户生效，不按学习空间或组织生效。
- 降级当天立即按新额度执行，不保留到次日。
- 长期授权只用于内部和系统授权，必须写明原因；赠送和试用必须有到期时间。
- 阶段 A–C 使用 SQL Editor 调用管理函数即可，暂不做管理员界面。

仍需产品决定：

1. 三档是否足够，是否需要团队版。
2. 免费档的数值，以及上线时为现有账号补授权的等级和期限。
3. 学习空间上限是只计活跃空间（本方案推荐），还是计全部空间。
4. 深度思考、导师模式、学习 AI 在后续版本中是否设为付费能力。
5. 区域视觉是否在第一版就需要独立额度（需要按 `route` 计数）。
6. OCR、向量化、章节摘要以后是否按会员分档；如果收紧 OCR，需要说明这是收回现有能力。
7. 每日重置沿用 UTC（北京时间 08:00），还是改为 `Asia/Shanghai`（需要 5 个账本一起改）。
8. 付费用户的失败请求是否继续计入次数（现状为计入）。
9. 高等级是否放宽每账号 1 个并发，以及后台任务是否单独占用名额。
10. 价格、币种、月付或年付、试用期，由阶段 D 的产品方案另行确定。

## 14. 实施记录

### 2026-09-25：阶段 A + B0（本地）

- 迁移 `supabase/migrations/20260927000100_membership_foundation.sql`：
  - 等级表（`free` 20 / `pro` 100 / `max` 300 次，学习空间上限三档均暂为 500，功能开关全开）、授权流水表及只允许撤销的触发器、`free` 保护触发器；
  - `effective_membership`、`my_membership`、`resolve_membership`，以及只有 `postgres` 可执行的 `grant_membership`、`revoke_membership_grant`、`revoke_active_memberships`；
  - `ai_requests.route` 列、`reserve_membership_ai_request`、`ai_membership_usage`；
  - 复制 `save_workspace`（沿用 `PT409` 改写后的定义），增加活跃空间上限检查，错误码 `PT403`。普通保存不解析会员，只有新增活跃空间时才查询。
- 服务端：
  - 新增 `CONUO_MEMBERSHIP_ENFORCEMENT`（默认 `off`，行为与迁移前一致，仍调用旧 RPC）；
  - 全部 9 处预占调用都传入路由和功能开关；
  - `feature_unavailable` 映射为 403 `MEMBERSHIP_FEATURE_REQUIRED`；影子模式输出 `membership_shadow` 结构化日志；
  - 用量接口在 `shadow`/`on` 下改读 `ai_membership_usage`，响应增加可选的 `membership` 字段；
  - `/api/v1/workspace` 把 `PT403` 映射为 403 `LEARNING_SPACE_LIMIT`。
- 测试：新增 `apps/web/src/lib/supabase/membership-sql.test.ts`（22 项，覆盖授权叠加与回落、未来生效、校验、只能撤销、角色权限、出错即拒绝、三种执行模式、降级后重放、空间上限与降级保存、注销级联）；更新请求账本、用量和相关路由测试；三个按顺序加载迁移的测试已登记新迁移。`apps/web` 全量 4571 项测试通过。
- 生产数据库（Supabase `conuo`）已由项目负责人应用本迁移，迁移历史登记为 `20260927000100 membership_foundation`；已只读核验等级配置、函数授权、`save_workspace` 替换、`route` 列、RLS 与触发器，以及无授权账号回落为免费版。staging 数据库尚缺此前 7 份迁移，未应用。
- 尚未做：生产 Vercel 设置 `CONUO_MEMBERSHIP_ENFORCEMENT=shadow` 与真实影子观察、B1 数值切换与现有账号补授权、阶段 C 的界面和权益接口、阶段 T 的 Token 计量。

### 2026-09-25：阶段 C 第一部分（会员展示）

- 新增 `GET /api/v1/account/membership`：用调用者自己的会话调用 `my_membership()`，并按 RLS 读取公开等级；返回等级、来源、生效与到期时间、到期后等级、执行模式、会员额度和最终可用的功能（部署开关叠加会员开关，仅 `on` 时叠加会员开关），不返回授权 ID。读取失败返回 503 `MEMBERSHIP_UNAVAILABLE`，不假定为免费版。Web 与 iOS/iPadOS 可共用。
- 设置 →「资料与 AI」新增会员面板：当前等级、来源、有效期与到期后等级（本机时间）、每日 AI 请求与活跃学习空间额度、各 AI 功能是否可用、公开等级对比，以及禁用状态的“升级（暂未开放）”。执行模式为 `off`/`shadow` 时明确提示仍按全站统一次数计算。
- 测试：路由 4 项、面板 5 项；`apps/web` 全量 4580 项通过。
- 尚未做：按最终权益隐藏或置灰各 AI 入口（目前三档功能全开，暂无行为差异）、iOS/iPadOS 端展示、设置页用量面板改读会员额度文案。

### 2026-09-25：阶段 C + T（本地功能分支）

- 会员面板与空间流程：学习空间上限为 500 时显示“暂不限制”；`off`／`shadow` 说明仍按当前系统上限。新建空间和取消归档前按会员接口预检；`/api/v1/workspace` 返回 `LEARNING_SPACE_LIMIT` 时提示“学习空间已满”，保留浏览器中的未保存内容。备份恢复和旧版导入在首次保存前按最终额度把超出的新增空间转为归档，并保留资料、笔记和警告提示；已有超额空间的普通编辑仍可保存。
- 最终权益控制：问答深度思考／导师模式、比较和跨库导师模式、区域截图学习、资料整理与知识更新、学习出题／批改／提示及复习批改入口同时检查 `NEXT_PUBLIC_CONUO_FEATURE_*` 与 `/api/v1/account/membership` 的 `features`。会员接口暂不可用时入口置灰并说明原因；阅读、搜索、笔记、导出和复习队列不受影响。没有在 iOS/iPadOS 增加付费升级入口。
- Token 账本：新增 `supabase/migrations/20260927000200_ai_request_token_ledger.sql`，为 `ai_requests` 增加 `prompt_tokens`／`completion_tokens`，新增可累加多次模型调用的六参数 `finish_ai_request`、保留旧四参数签名、服务端 Token-only 账本和按 UTC 当日汇总的 `ai_token_usage_today`。问答（含查询改写和回答校验）、整理、后台整理、区域视觉、学习四路由、术语建议、OCR 转写和章节摘要均写入账本；供应商无用量字段时使用固定字符近似策略。`CONUO_AI_DAILY_TOKEN_LIMIT` 仍是全局配置，没有加入会员等级数值。
- 测试：三个按顺序加载迁移的 PGlite 测试已登记新迁移；`membership-sql.test.ts` 与 `ai-token-usage-sql.test.ts` 覆盖正常累加、Token-only、拒绝、权限、旧签名和 `off` 路径不变；新增会员入口、空间预检、备份降级保存组件／单元测试。迁移和代码只在本地功能分支验证，未对 Supabase、Vercel 或部署环境执行操作；生产／staging 应在上线前按顺序人工应用新迁移。
- 未改变会员数值、既有账号授权、执行模式或每日重置时区；Token P95 标定和按等级分档仍待产品负责人决定。
