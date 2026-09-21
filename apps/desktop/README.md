# Conuo Desktop Preview

Windows / macOS 桌面客户端的第一阶段实现。使用 Electron + TypeScript，在隔离的网页渲染进程内加载现有 Conuo 云端界面，让资料库、阅读器、笔记、AI 和账号设置与当前 Web 版本保持一致。

**这是联网预览版，不是完整的本地优先桌面端。** 本地资料库、离线编辑、同步队列及冲突处理仍需后续实现；桌面专用 PRD 定义的完整产品不能以此版本替代。

## 当前功能

| 能力         | 当前实现                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------ |
| Web 业务界面 | 加载配置环境的完整页面，复用现有云端逻辑                                                   |
| 平台窗口     | 原生 Windows / macOS 窗口，单实例，调整大小、全屏                                          |
| 导航         | 40px 浅灰一体标题栏，前进、后退、重新加载、学习概览；原生窗口控制保留                      |
| 菜单与快捷键 | Windows 使用 Ctrl，macOS 使用 Cmd；剪贴板、缩放、导航和下载菜单                            |
| 云端会话     | 持久化且按环境及 origin 隔离，与系统浏览器登录独立                                         |
| 导出 / 下载  | Web 生成的文件和备份使用原生“另存为”；显示进度、完成、取消与中断；可显示已保存文件所在目录 |
| 连接恢复     | 网络错误、HTTP 错误与渲染进程退出显示本地恢复页，支持重试                                  |
| 外部链接     | 确认后在系统浏览器打开公开 HTTP(S) 地址                                                    |
| 自动更新     | 尚未实现；需手动替换安装包，不自动下载或执行更新                                           |
| 离线知识库   | 尚未实现；缓存与下载副本不等于可离线编辑的资料库                                           |
| 原生登录回跳 | 尚未实现自定义协议回跳；首阶段使用已有账号在应用内登录，邮件链接按现有 Web 流程处理        |

相机、麦克风、屏幕录制、地理位置、通知及任意设备权限默认关闭。已有 PDF 区域截取基于文档画布，不需要操作系统屏幕录制权限。复制按钮只允许当前可信且获得焦点的主页面写入纯文本剪贴板；不授予读取剪贴板权限。

## 开发

在仓库根目录使用 Node.js 24+：

```powershell
npm install
npm run dev --workspace @conuo/desktop
```

默认连接 `https://conuo-staging.vercel.app`。客户端不读取 Web 的 `.env`、数据库凭据或服务端密钥。默认启动不连接生产。

本地前后端开发时，先在另一个终端启动 Web，然后为桌面进程明确指定 loopback 地址：

```powershell
$env:CONUO_DESKTOP_ENV = 'development'
$env:CONUO_DESKTOP_URL = 'http://127.0.0.1:3000'
npm run dev --workspace @conuo/desktop
```

`development` 仅允许未打包程序加载本机 loopback HTTP。打包客户端拒绝该模式。恢复默认时移除上面两个进程环境变量。

正式环境需要设置 `CONUO_DESKTOP_ENV=production` 及明确的 `CONUO_DESKTOP_URL=https://<正式域名>`；地址必须是公开 HTTPS origin，不能携带路径、账号、查询参数或片段。该开关只是客户端连接配置，**不会迁移或部署生产数据库**。发布前应为正式包固化经过验收的连接配置并完成签名。

## 验证与打包

```powershell
npm run typecheck --workspace @conuo/desktop
npm run test --workspace @conuo/desktop
npm run smoke --workspace @conuo/desktop
npm run dist:win --workspace @conuo/desktop
```

`test` 覆盖环境隔离、精确 origin、导航与外链协议、下载发起来源、危险文件名与 IPC 参数边界。`smoke` 启动一个独立 loopback 页面和隐藏 Electron 窗口，不登录、不访问 Supabase、不访问真实云端；验证网页与主进程隔离、拒绝弹窗及文件导航、权限拒绝、真实 Blob 下载以及网络错误恢复。报告、截图和独立浏览器缓存保留在 Git 忽略的 `.smoke/` 中。测试结束时停止其服务器与 Electron，不复用用户会话。

当前验证为 **15 条 Node 测试、40 项真实 Electron 隐藏冒烟断言**。覆盖窗口恢复、面板历史导航、标题栏布局、原生窗口按钮预留区域及菜单 IPC 白名单。关闭窗口时有下载的回归覆盖“继续下载”保留窗口和任务，以及“取消下载并退出”同时取消任务并销毁窗口；冒烟仅注入原生确认框的选择结果，实际执行生产关闭处理函数与 Electron 下载、窗口生命周期。

另已使用隔离 Electron Session 与 staging 的现有 QA 账号，验证 Cookie 登录、独立进程重启、云端笔记保存、旧 revision 冲突、原件完整性、退出和账号切换隔离。该验证直接使用网络/会话 API，不等于窗口界面验收；QA 资料的现有 AI 权限未开启，本轮未调用模型。详见 [Windows D1 验收记录](../../docs/WINDOWS_DESKTOP_ACCEPTANCE.md)。

Windows 产物在 `release/`，使用免安装便携包。当前为**未签名内部预览包**。不要将安全提示或缺少签名当成已经通过正式发布验收。

当前本地版本为 `0.1.4`；旧预览包保留用于对照。标题栏与 Windows 原生窗口按钮统一使用 Conuo 辅助底色 `#f7f7f8`，侧边栏开关、文件、编辑、视图、帮助与导航放在同一行，移除传统菜单栏占位。菜单使用原生弹出层，保留已有快捷键；macOS 使用系统菜单并预留交通灯位置。窗口尺寸、最大化与缩放记忆、编辑区右键菜单及 F5 未保存内容保护继续保留。

本轮检查了宽窗口及 880px 窄窗口的真实 Electron 渲染截图；截图不包含系统合成的窗口按钮。原生菜单点击、标题栏拖拽、双击最大化、系统缩放和 macOS 布局仍待实机验收。菜单提供基础方向键和 Alt/F10 入口；原生弹出菜单关闭后，键盘焦点回到正文，尚未实现连续左右切换顶层菜单的完整体验。

`0.1.4` 将标题栏最左侧 Logo 换成侧边栏图标，保留“文件”菜单；点击或按 `Ctrl+\`（macOS 为 `Cmd+\`）切换主侧栏，正文自动扩展。状态在本次进程的页面跳转和刷新中保留，重启恢复展开；固定样式仅作用于工作区主侧栏，不处理阅读器内部目录、AI 面板或业务草稿。桌面缩放进入手机断点时，主侧栏仍以文档流内面板受此按钮控制，避免网页抽屉的默认隐藏或遮罩妨碍操作。该适配通过 Electron 的固定 [insertCSS/removeInsertedCSS](https://www.electronjs.org/docs/latest/api/web-contents#contentsinsertcsscss-options) 完成，不增加远程 preload，不需要部署 Web。

隐藏冒烟使用独立测试目录保存下载，验证真实文件内容与取消结果；它不操作系统“另存为”窗口。原生保存位置选择、覆盖确认、已登录云端业务回归以及不同 Windows 系统版本仍需桌面人工验收。未保存内容的关闭与重载防护由 Web 的 `beforeunload` 状态触发，并保留其当前页面。

macOS 配置了 Intel / Apple Silicon DMG 目标；需要在 macOS 上执行：

```sh
npm run dist:mac --workspace @conuo/desktop
```

macOS 真机、Gatekeeper、签名与 notarization 尚未验收。Windows 构建成功不能证明 macOS 可用。

下载面板只记录本次进程内的下载；重启不恢复任务，不自动打开下载文件。取消不会删除已有用户文件；浏览器负责取消当前未完成下载。退出时如有下载任务，先提示用户继续下载或取消后退出。文件备份仍使用 Web 原有导出与恢复格式。

## 安全边界

- 远程内容使用 `WebContentsView`；没有 preload、Node、IPC bridge、通用文件访问或 shell 权限。
- 主窗口仅加载打包的本地 `conuo-desktop://app` 页面，并设置限制性 CSP；本地 preload 只提供固定桌面操作。
- 每条 IPC 同时核对本地主窗口、主 frame、完整 URL 及操作类型；远程页面不能调用本地工具条接口。
- 所有渲染器启用 sandbox / context isolation / web security；不忽略证书错误。
- 同源路由留在客户端；新窗口、跨源跳转、任意系统协议和子 frame 导航受限制。默认浏览器外链需要本地确认。
- 下载同时检查发起 origin 与下载 URL，仅允许应用同源与应用生成的 Blob；Web 当前备份和原文件下载均使用 Blob。远程页面不能指定本机保存路径。
- 无更新服务、开机启动、全盘文件索引、目录监听、托盘常驻或远程调试端口。

实现依据：[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)、[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)、[DownloadItem](https://www.electronjs.org/docs/latest/api/download-item)。
