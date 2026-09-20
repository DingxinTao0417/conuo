# Staging 灾备恢复演练

更新日期：2026-09-20。本文用于把独立 staging 的 PostgreSQL、Auth 元数据、Storage 元数据和原件字节恢复到另一个隔离 Supabase 项目。它不授权生产变更，也不把应用内个人 ZIP 当作服务端灾备。

## 当前状态

完整演练尚未执行。用户已明确不在本机下载 PostgreSQL，因此不再把安装 `psql`／`pg_dump` 或本机 Docker 作为当前恢复路径。此前下载到 Git 忽略演练目录的 PostgreSQL 安装包及清单已删除，没有安装程序、PostgreSQL 进程、服务或系统配置残留。

2026-09-20 在 Supabase 控制台只读复核：staging 所在组织和项目仍为 Free；Scheduled backups 明确显示 Free 不包含项目备份，“Restore to new project”明确要求 Pro 及已启用的物理备份。Preview Branch 可以建立隔离环境，默认不复制数据，也可在 Dashboard 选择包含生产数据；它会产生独立 Compute、磁盘、网络和 Storage 用量，且分支克隆不等于从备份恢复，不能用来关闭灾备恢复闸门。当前选择的数据库路径只有：单独授权升级 staging 到 Pro，等待并确认一份物理备份后，通过 “Restore to new project” 恢复到新的隔离项目。

2026-09-20T15:44Z 已用仓库脚本真实读取 staging 私有 Storage，备份 1 个桶、6 个对象、834 字节；本机独立复核全部对象长度和 SHA-256 与 manifest 一致。产物保存在 Git 忽略的 `work/staging-release/disaster-recovery/20260920T154438Z/storage/`，manifest SHA-256 为 `5f78cc89f1096703136411ee2ab2f4e5ff136ae9793eb3fb95c0ebf2d297c8c1`。这只证明源对象字节可以导出，不证明数据库、Auth、Vault 或目标 Storage 可以恢复。

下文 CLI 逻辑导出流程保留为未采用的备选记录，不再执行或安装本机依赖。当前云端路径由 Supabase 生成并恢复物理备份；Storage 对象字节仍需使用仓库脚本单独恢复并逐个核对 SHA-256，因为数据库备份中的 Storage 元数据不能证明对象字节已经恢复。

## 云端恢复路径

该路径会升级付费方案并创建新的云资源，只有获得单独授权后才能执行：

1. 记录升级前的组织、staging 项目、Git SHA、迁移上界、数据库区域和 Storage 对象清单，不记录密钥或完整对象路径。
2. 将 staging 所在组织升级到 Pro；不同时修改原生产项目、Vercel 项目或应用环境变量。
3. 在 Supabase Backups 页面确认物理备份已生成且可选择；没有实际备份时不能进入恢复。
4. 使用 “Restore to new project” 创建隔离恢复项目，不覆盖 staging 或原生产项目。
5. 在新项目检查 Auth、业务 Schema、`conuo_private`、扩展、函数、触发器、RLS、迁移历史和 Storage 元数据。
6. 使用现有 Storage 备份脚本向新项目恢复对象字节并逐对象核对长度与 SHA-256。
7. 完成下方恢复验收，记录新项目的保留或删除终态；删除项目、降级方案和其他费用变更分别记录。

Supabase Preview Branch 只用于额外的迁移或隔离行为测试。即使选择 “Include data”，也不能替代上述物理备份恢复证据；分支用量不受 Spend Cap 覆盖，创建前同样需要费用授权。

## 隔离与凭据

- 源项目只能是 `conuo-staging`，目标必须是新建的隔离恢复项目，不能使用原生产项目。
- 数据库连接串使用 Supabase Connect 面板的 Session Pooler URL，密码必须百分号编码。只通过当前进程环境变量传入，不写入仓库、文档、命令记录或结果 JSON。
- Storage 使用两个项目各自的 secret/service-role key。脚本要求显式输入项目 ref，并拒绝源、目标 ref 相同。
- 所有导出放在 `work/staging-release/disaster-recovery/<UTC 时间>/`；`work/` 已被 Git 忽略。完成后记录保留或清理终态。
- 若项目使用 Vault／pgsodium，恢复前还必须按官方文档复制旧项目 root encryption key。本项目的 processor secret 当前保存在 staging Vault，因此演练必须覆盖这一项，不能只恢复可见业务表。

## 1. CLI 备选路径前置条件（当前不执行）

1. 安装并启动 Docker Desktop 或 Podman，供 Supabase CLI 执行 `pg_dump`。
2. 安装与托管数据库主版本兼容的 PostgreSQL `psql`。
3. 从 staging Connect 面板取得源 Session Pooler URL；如需重置数据库密码，先评估已有连接并单独记录变更。
4. 创建新的隔离 Supabase 项目，取得目标 Session Pooler URL、项目 URL 和 secret/service-role key。
5. 不复制 Vercel、Cron 或模型配置到恢复项目；恢复验证只使用专用 QA 账号与自编资料。

先运行只读预检：

```powershell
powershell -File scripts/supabase-database-recovery.ps1 `
  -Mode Preflight `
  -OutputDirectory work/staging-release/disaster-recovery/20260920T000000Z
```

`backupReady` 和 `restoreReady` 只有在对应运行时及环境变量齐全时才为 `true`。

## 2. 备份数据库和 Storage

在当前 PowerShell 会话设置源变量，不把值写入 `.env`：

```powershell
$env:CONUO_DR_SOURCE_DB_URL = '<staging session pooler URL>'
$env:CONUO_DR_SOURCE_URL = 'https://<staging-ref>.supabase.co'
$env:CONUO_DR_SOURCE_SERVICE_KEY = '<staging secret key>'
```

执行数据库导出：

```powershell
powershell -File scripts/supabase-database-recovery.ps1 `
  -Mode Backup `
  -OutputDirectory work/staging-release/disaster-recovery/20260920T000000Z/database `
  -ConfirmSourceRef <staging-ref>
```

脚本生成 `roles.sql`、`schema.sql`、`data.sql`、迁移历史和 SHA-256 清单；任何一步失败都会保留 `.incomplete`，不能把该目录标作有效备份。

执行 Storage 原件备份：

```powershell
node scripts/supabase-storage-recovery.mjs backup `
  --directory work/staging-release/disaster-recovery/20260920T000000Z/storage `
  --confirm-source-ref <staging-ref>
```

对象字节按 SHA-256 保存，manifest 保留私有桶配置、对象路径、长度与哈希。证据汇总只能记录数量、总字节和哈希清单文件自身的指纹，不公开对象路径。

## 3. 恢复到隔离项目

先设置目标变量：

```powershell
$env:CONUO_DR_TARGET_DB_URL = '<target session pooler URL>'
$env:CONUO_DR_TARGET_URL = 'https://<target-ref>.supabase.co'
$env:CONUO_DR_TARGET_SERVICE_KEY = '<target secret key>'
```

恢复数据库：

```powershell
powershell -File scripts/supabase-database-recovery.ps1 `
  -Mode Restore `
  -OutputDirectory work/staging-release/disaster-recovery/20260920T000000Z/database `
  -ConfirmTargetRef <target-ref>
```

脚本先复核全部备份 SHA-256，再按角色、Schema、数据、迁移历史顺序恢复。出现任意 `psql` 错误会终止，不能继续 Storage 或应用验收。若遇到官方文档列出的 `supabase_admin` 或 `cli_login_postgres` 权限错误，保留原备份，按官方处理方法生成经过审阅的恢复副本，不改写原始文件。

数据库恢复完成后，用 `upsert` 写回对象字节；这是为了补齐已经恢复的 `storage.objects` 元数据，只能对本次隔离目标执行：

```powershell
node scripts/supabase-storage-recovery.mjs restore `
  --directory work/staging-release/disaster-recovery/20260920T000000Z/storage `
  --confirm-target-ref <target-ref>

node scripts/supabase-storage-recovery.mjs verify `
  --directory work/staging-release/disaster-recovery/20260920T000000Z/storage `
  --confirm-target-ref <target-ref>
```

## 4. 恢复验收

以下全部通过才算恢复成功：

1. 迁移历史与源 staging 一致，当前应为 27 份；从仓库空库顺序重放 27 份迁移也必须单独通过。
2. 两个 QA 账号可以登录；A/B 工作区、规范化投影与 RLS 隔离正确，B 不能读取 A 的原件。
3. Storage bucket 数、对象数、总字节和逐对象 SHA-256 与 manifest 一致。
4. 工作区 revision、资料／版本／块、笔记历史、对话、批注、知识关系和整理任务抽查一致。
5. Auth 用户、账号删除栅栏、上传预留、资料清理、账号注销和模型账本没有被错误重开。
6. Vault 中的 processor secret 可在目标项目正确解密，或明确重新配置且旧密文未被误报为可用。
7. 在恢复项目完成登录、原件下载、工作区读取、409 冲突与一条无模型破坏性的保存冒烟测试。

结果记录包含源／目标项目代号、Git SHA、UTC 时间、工具版本、文件哈希、表／对象计数与验收结论；不得包含数据库 URL、密码、service-role key、Auth token、邮箱或完整对象路径。

## 5. 终态

演练完成后明确记录恢复项目是保留、暂停还是删除。删除项目、重置数据库密码、升级套餐或复制 Vault root key 都属于独立的外部变更；执行前按当次授权处理。源 staging 的 QA 夹具、自然 Cron 和刷新会话验收在各自完成前不得因灾备演练被清理。
