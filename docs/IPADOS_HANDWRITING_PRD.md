# Conuo iPadOS PDF 手写阅读专项 PRD

| 属性        | 内容                                                                          |
| ----------- | ----------------------------------------------------------------------------- |
| 版本 / 日期 | v1.0 / 2026-09-22                                                             |
| 状态        | 开发基线；本文定义目标与验收，不代表功能已经实现                              |
| 适用端      | iPadOS 原生应用，首期只覆盖 PDF 阅读与手写学习工作台                          |
| 上位文档    | [iPadOS App PRD](IPADOS_PRD.md)、[iOS App PRD](IOS_PRD.md)、[主 PRD](PRD.md)  |
| 当前工程    | `apps/mobile`，React Native + Expo + TypeScript                               |
| 目标读者    | 产品、设计、iOS / React Native 开发、测试，以及按任务逐项执行的低能力开发模型 |

> 本文是 iPadOS PRD 中“原生 PDF + Apple Pencil + 区域 AI”的实施级补充。冲突时，账号、权限、资料版本和云端删除遵循上位文档；PDF 手写的界面、坐标、存储、冲突和验收以本文为准。

## 0. 给开发模型的执行规则

开发模型必须先读完本节，再领取第 23 节中的单个工作包。不得把多个工作包合并成一次大改。

1. 每次只实现一个可独立验收的纵向切片，先列出将修改的文件和不修改的范围。
2. 原生 PDF、Pencil 输入和真机手势必须在 macOS + Xcode + iPad 真机验证；浏览器预览、iOS 模拟器截图或静态 UI 不能替代真机证据。
3. 不得把 Web PDF 组件、DOM Canvas 或网页嵌入当作 iPad 原生手写完成证据。
4. 不得在 JavaScript Bridge 上逐点传输 Pencil 轨迹。低延迟采集、渲染、撤销和页内坐标转换必须留在原生层。
5. 不得复用现有 `public.annotations` 保存原始笔迹。它是 `workspaces.data.annotations` 的文字批注读投影，写入权威仍是工作区快照。
6. 新增数据库结构必须使用新的迁移；不得修改已经应用的迁移文件，不得手工改生产数据库。
7. 不得把服务端密钥、模型密钥或 Storage 管理凭据写入客户端、日志、截图、测试夹具或文档。
8. 原生请求沿用 Bearer 会话和 `X-Conuo-User` 身份头；服务端仍需验证令牌、账号状态、资料权限和版本，不信任客户端传入的 owner。
9. 不启动或安装本地 PostgreSQL。数据库测试继续使用项目已有的隔离方案；真实迁移只按项目发布流程执行。
10. 不提交、推送、部署、创建付费资源或修改生产环境，除非当次任务获得明确授权。
11. 每个工作包结束时报告：改了什么、如何验证、哪些是真机结果、哪些仍是假设、是否有未跟踪文件和运行中的服务。
12. 无法证明的能力必须标为“未完成”或“仅开发预览”，不得用“已支持”代替。

## 1. 产品结论

Conuo iPad 端的核心形态是“可以直接写画的 AI 学习阅读器”：

- 用户在 PDF 原件上用 Apple Pencil 书写、划线、擦除和撤销。
- 文档级命令位于顶部；高频书写工具位于画布左侧的悬浮工具条；中央尽量只显示资料。
- 单页与连续阅读可切换，缩放、旋转和重新打开后笔迹仍与原文同一位置。
- 原始笔迹先保证可靠保存，再提供识别、解释和出题。识别失败不能改写或丢失原笔画。
- 用户可以框选一页内的区域，预览实际将发送的图像，选择是否包含自己的笔迹，再让 AI 解读、问答或出题。
- 云端是跨设备权威；iPad 额外保留最小化的“未同步笔迹恢复箱”，只用于防止杀进程、断网或上传失败导致用户手写消失，不构成完整离线资料库。

第一版不追求成为通用笔记本或绘画应用。目标是把“读资料—写理解—问 AI—形成可恢复学习痕迹”做完整。

## 2. 参考图分析

### 2.1 可以借鉴的交互

六张参考图中，第 6 张的阅读工作台是本专项的主要参考，其他图片只用于理解产品气质。

| 参考区域        | 可借鉴点                               | Conuo 中的落地                                             |
| --------------- | -------------------------------------- | ---------------------------------------------------------- |
| 顶部文档工具栏  | 文档导航、搜索、显示和分享集中在同一层 | 保留返回、阅读模式、页码、搜索、AI 区域、面板、分享 / 更多 |
| 左侧悬浮笔栏    | 高频书写工具与文档命令分开，不挤占顶部 | 自定义 Conuo 浮动笔栏，支持折叠和安全边距                  |
| 中央连续页面    | 页面上下连续，灰色工作区衬托白色 PDF   | 连续模式保持页间距和页码提示；另有单页模式                 |
| 直接可见的颜色  | 不打开多级菜单即可切常用色             | 默认显示 6 个最近 / 固定色，更多颜色进入色板               |
| 撤销 / 重做置顶 | 书写后的恢复动作容易找到               | 只作用于当前页当前批注层，并显示禁用态                     |
| 50% 缩放控件    | 用户知道当前视图比例                   | 显示缩放百分比；支持适合宽度、适合整页和手动缩放           |
| 大尺寸模态面板  | 设置或说明覆盖在当前上下文上           | AI 结果和文档信息使用侧栏或自适应 Sheet，不复制订阅弹窗    |

### 2.2 不应照搬的部分

- 不复制 BBNotes 的品牌、图标、紫色渐变、登录页、Pro 试用条、订阅弹窗或账户信息架构。
- 不在顶部堆叠一排无文字、含义不明的小图标。每个按钮必须有 VoiceOver 标签、按下态和必要的短提示。
- 不让悬浮笔栏永久遮住页边内容。用户可折叠；窄窗口时可改为底部横向工具栏。
- 不把 AI、录音、翻译、文本框、拍照等所有能力同时暴露。首版顶部只保留当前阅读任务需要的动作。
- 不用稀疏大空白代替资料组织。资料库继续遵循 Conuo 现有信息架构。
- 不用付费弹窗打断正在书写的动作；额度或权限限制在用户发起对应能力时说明。

### 2.3 视觉方向

沿用 Conuo 现有中性灰底、白色资料页和品牌紫作为选择态。画布是内容主角，工具表面使用轻边框、轻阴影和明确层级，不使用大面积发光或玻璃模糊。

- 工作区背景：浅色模式使用中性浅灰；深色模式降低眩光，但 PDF 原页默认保持原色。
- 顶部栏：与 Conuo 导航表面同色，底部 1px 分隔线；不额外放置大 Logo。
- 工具栏容器：圆角 16pt，阴影只用于与页面分层；当前工具用品牌浅底 + 品牌色描边。
- PDF 页：不额外加粗边框；页面阴影仅用于区分工作区。
- 危险动作：删除笔迹使用文字确认，不只使用红色图标。
- 动效：工具切换 120–180ms；尊重“减弱动态效果”，不得对笔迹本身添加跟随动画。

## 3. 范围与非范围

### 3.1 首个可发布范围

| 能力        | 必须达到                                                         |
| ----------- | ---------------------------------------------------------------- |
| 原生 PDF    | 打开已授权 PDF 原件；单页 / 连续阅读；缩放、搜索、页码跳转       |
| Pencil 书写 | 钢笔、铅笔、荧光笔、橡皮擦、套索、颜色、粗细、撤销 / 重做        |
| 手势协调    | 默认 Pencil 写、手指平移 / 缩放；手掌误触由系统手写层处理        |
| 可靠保存    | 页级本地恢复、云端版本、真实保存状态、冲突保留和删除             |
| 跨端可见    | Web 至少能识别“有手写批注”并显示透明预览；Web 首版不编辑原始笔迹 |
| 区域 AI     | 单页框选、图像预览、可选包含笔迹、解读 / 问答 / 出题、结构化结果 |
| 适配        | 横竖屏、常用 iPad 全屏和系统窄分屏；外接键盘 / 触控板基础操作    |
| 无障碍      | 44×44pt 命中、VoiceOver 标签、焦点顺序、状态不只依赖颜色         |

### 3.2 本专项不包含

- 通用无限画布、白板、思维导图或复杂图层编辑。
- 实时多人共同书写、笔迹逐点协同或自动合并同一笔画。
- 以 OCR 作为前置步骤；区域 AI 直接使用用户确认的图像。
- 默认上传整页、整份文档或后台自动分析全部手写。
- 手写转文字、公式识别、字迹美化、自动判分和搜索手写内容。这些属于后续独立验收。
- iPhone 上完整手写工作台；iPhone 只需能识别该资料有手写并显示只读预览或说明。
- Web 编辑 PencilKit 原始数据。
- 在没有真机证据时承诺所有 Apple Pencil 型号、悬停、双击或挤压手势。

## 4. 用户任务与成功标准

### 4.1 核心任务

1. **边读边写：** 打开课程 PDF，用 Pencil 写下推导或划重点，手指继续滚动和缩放。
2. **写完安心离开：** 用户看到“已保存到云端”后关闭应用，再次打开仍在准确位置。
3. **断网继续保护：** 网络中断时继续书写，界面明确显示“保存在本机，等待同步”，恢复网络后可同步。
4. **框选求助：** 圈出图、公式或自己的笔记，确认截图范围，向 AI 请求解读或出题。
5. **换端接续：** Web 打开同一版本资料时看到手写预览和更新时间，不把它误认为普通文字批注。
6. **处理冲突：** 两台 iPad 修改同一页时不静默覆盖，保留两份可识别版本供用户选择。

### 4.2 产品成功指标

以下指标先用于测试门槛，正式目标在基准设备实测后冻结：

- 云端确认后的笔迹重开恢复率：100%。
- 杀进程前已写入本机恢复箱的笔迹恢复率：100%。
- 同一资料版本、同一页在缩放 / 旋转 / 单页连续切换后的对齐错误：肉眼不可见，自动坐标测试误差不超过页面短边的 0.25%。
- 任何保存失败、权限改变或版本冲突：0 次静默丢弃，0 次错误显示“云端已保存”。
- 区域 AI 实际上传图片与确认预览一致；不得含相邻页面、工具栏、聊天面板或其他 App。
- 300 页 PDF 只按可见页加载手写层；滚动期间不因远端保存阻塞 Pencil 渲染。

## 5. 信息架构与主流程

### 5.1 入口

资料库中的 PDF 卡片打开 `sources/:sourceId`。服务端解析出当前不可变 `versionId` 后才能进入原生阅读器。没有原件权限、原件缺失或版本已删除时，不加载旧缓存冒充可用资料。

资料详情提供：

- “阅读原文”主按钮；
- 手写批注数量和最后更新时间；
- 保存异常徽标，仅在存在未同步本机笔迹或冲突时显示；
- “在 Web 打开”属于跨端操作，不替代原生手写入口。

### 5.2 标准流程

1. 读取资料身份、当前版本和权限。
2. 获取 PDF 私有下载地址或受保护流，写入当前阅读所需的临时文件。
3. 打开原生 PDFView，恢复最后确认的页与阅读模式。
4. 拉取笔迹 manifest，只加载可见页及前后各一页的当前 head。
5. 用户点“标注”进入手写模式；首次进入显示 3 条简短提示：Pencil 书写、手指移动、状态位置。
6. 原生层记录页内修改并立即写入本机恢复文件；RN 只接收“第几页已变脏”等粗粒度事件。
7. 自动保存任务上传原始笔迹和透明预览，服务端 CAS 提交成功后显示“云端已保存”。
8. 用户退出时，如仅剩正在上传内容，可离开并在后台允许范围内继续；如本机落盘失败，必须阻止无提示离开。

### 5.3 区域 AI 流程

1. 用户点“AI 区域”，阅读器切到 `regionSelect`，暂时停止写画。
2. 只能在单个物理页内拖出矩形；跨页拖动在页边界截断并提示。
3. 原生层渲染该矩形，不包含系统 UI；用户可切换“包含我的手写”。
4. Sheet 展示准确预览、页码、任务选项和隐私说明。
5. 用户选择“解读”“提问”或“出题”；提问必须输入问题。
6. 请求发送前再次核验账号、资料、版本、页码和 AI 权限。
7. 结果在右侧面板或底部 Sheet 结构化呈现；关闭结果不改变原文位置。

## 6. 自适应页面布局

布局按当前窗口可用宽度，不按设备型号判断。

| 可用宽度    | 阅读布局               | 手写工具                           | AI 结果                     |
| ----------- | ---------------------- | ---------------------------------- | --------------------------- |
| `< 600pt`   | 单资料全屏，顶部紧凑栏 | 底部可横向滚动工具条；默认折叠颜色 | 全屏 Sheet                  |
| `600–899pt` | 单资料，必要时隐藏目录 | 左侧悬浮纵向工具条                 | 右侧覆盖 Sheet 或底部 Sheet |
| `>= 900pt`  | 资料 + 可选右侧面板    | 左侧悬浮纵向工具条                 | 右侧 320–420pt 可调面板     |

共同规则：

- PDF 可视区不能被安全区、顶栏、工具条或系统键盘覆盖。
- 横竖屏切换保留资料身份、物理页、页内语义锚点、缩放模式、当前工具、未发送问题和未同步笔迹。
- 系统分屏缩窄时先关闭辅助面板，再把左侧笔栏变为底栏；不得缩小命中区域。
- 外接显示器按窗口宽度重排，不把“外接显示”当作固定桌面尺寸。
- 右侧面板打开时，PDF 使用剩余宽度重新布局；连续模式恢复当前中心页，而不是跳回第一页。

## 7. 阅读器顶部栏

### 7.1 宽屏顺序

从左到右固定为：

1. 返回；
2. 文档标题和版本状态，标题过长截断；
3. 单页 / 连续阅读切换；
4. 当前页输入与总页数，例如 `49 / 315`；
5. 搜索；
6. 标注模式开关；
7. AI 区域；
8. 目录 / 批注 / AI 面板开关；
9. 分享；
10. 更多；
11. 保存状态；
12. 缩放减小、百分比、缩放增大。

标题栏不显示大 Logo。保存状态必须持续可见，不能藏在“更多”中。

### 7.2 紧凑顺序

窄窗口仅直接显示：返回、短标题、页码、标注、AI 区域、保存状态、更多。阅读模式、搜索、面板、分享和缩放预设进入“更多”，但当前缩放仍可通过双指操作。

### 7.3 控件规则

- 触摸目标不小于 44×44pt，图形本体可为 20–24pt。
- 选中、按下、禁用、键盘焦点和 VoiceOver 焦点均有独立状态。
- 页码输入只接受 `1...pageCount`；提交非法值后恢复原页并朗读错误。
- 缩放百分比四舍五入显示；点百分比打开“适合宽度 / 适合整页 / 100%”。
- 搜索无文字层时显示“此 PDF 没有可搜索文字”，不禁用区域 AI。
- 分享导出原件或带批注副本前必须说明范围；首版可只分享原件，并明确“手写未包含”。
- 顶栏收起可作为后续专注模式；首版不能让保存状态一起消失。

## 8. 悬浮手写工具栏

### 8.1 纵向工具顺序

宽度不小于 600pt 时，从上到下：

1. 拖动把手；
2. 撤销；
3. 重做；
4. 分隔线；
5. 钢笔；
6. 铅笔；
7. 荧光笔；
8. 橡皮擦；
9. 套索；
10. 分隔线；
11. 当前粗细；
12. 6 个常用色；
13. 更多颜色；
14. 收起。

首版尺子作为 P2.5 增强，不阻塞首发。若系统与当前 PencilKit 版本可以稳定提供，才在“更多”中开放并单独验收。

### 8.2 工具参数

| 工具   | 默认值                    | 再次点击当前工具                 |
| ------ | ------------------------- | -------------------------------- |
| 钢笔   | 黑色，2.0pt，实色         | 打开 1 / 2 / 4 / 6pt 和颜色      |
| 铅笔   | 深灰，2.0pt，系统笔触     | 打开粗细和颜色                   |
| 荧光笔 | 黄色，8.0pt，系统高亮混合 | 打开 6 / 8 / 12 / 16pt 和颜色    |
| 橡皮擦 | 优先整笔擦除              | 切换整笔 / 像素擦除；不擦 PDF    |
| 套索   | 无颜色                    | 选择后允许移动、缩放、复制、删除 |

显示宽度是“页面 100% 尺寸下的逻辑宽度”，缩放页面不改变笔画相对原文的宽度。

### 8.3 颜色

默认常用色：黑、深灰、红、蓝、绿、黄。荧光笔默认显示适合高亮的半透明版本。色板支持：

- 最近使用；
- 预设色；
- 自定义色；
- 颜色十六进制仅作为内部值，不要求用户输入；
- 对比度不足时提醒，但不禁止用户选择；
- 颜色选择不改变既有笔画，除非用户已经套索选中并明确执行“更改样式”。

### 8.4 位置与遮挡

- 默认距左侧安全区 16pt，垂直居中。
- 拖动后吸附左 / 右边缘并保存为设备偏好，不写入云端业务数据。
- 工具栏不得进入顶部栏、Home Indicator 或系统键盘区域。
- 工具栏与选中的套索、AI 框或系统菜单重叠时，临时移到另一侧。
- 收起后保留 44pt 的“笔”按钮；展开恢复上次工具和位置。
- 窄窗口变为底部工具条，常用色横向滚动，保存状态仍在顶栏。

## 9. 模式与手势状态机

### 9.1 顶层模式

```text
read
  ├─> ink.pen
  ├─> ink.pencil
  ├─> ink.highlighter
  ├─> ink.eraser
  ├─> ink.lasso
  └─> regionSelect

任一 ink.* ──标注开关关闭──> read
regionSelect ──确认──> regionPreview ──关闭 / 完成──> read
regionSelect ──取消──> 上一个稳定模式
```

不得让 `ink.*` 与 `regionSelect` 同时生效。打开系统搜索、分享或资料信息时保留模式选择，但暂停落笔。

### 9.2 默认输入

| 输入         | `read`                         | `ink.*`                    | `regionSelect`          |
| ------------ | ------------------------------ | -------------------------- | ----------------------- |
| Apple Pencil | 系统允许时选择文字；否则无写入 | 当前工具书写 / 擦除 / 套索 | 拖出选区                |
| 单指         | 滚动 / 翻页 / 点按             | 平移页面，不画线           | 拖动选区或调整手柄      |
| 双指         | 缩放 / 平移                    | 缩放 / 平移                | 缩放 / 平移，不改变选区 |
| 触控板       | 滚动、缩放、选择               | 滚动、缩放；点击工具       | 创建 / 调整选区         |
| 键盘         | 页码、搜索、快捷键             | 同左，外加撤销 / 重做      | Esc 取消，Enter 确认    |

默认 `drawingPolicy = pencilOnly`。用户可在设置中开启“手指也可书写”，开启后必须显示明显提示，双指仍负责页面移动。该偏好只影响本设备。

### 9.3 手势优先级

1. 系统安全区和系统手势；
2. PencilKit 当前工具；
3. AI 选区手柄；
4. PDF 文字选择；
5. PDFView 平移 / 缩放；
6. React Native 外层导航手势。

阅读器打开时，左边缘返回手势不能吞掉靠左书写。标注模式下优先提供显式返回按钮；是否保留边缘返回须真机验证后决定。

### 9.4 Pencil 特有能力

- 悬停、双击、挤压只在系统报告可用时出现。
- 悬停可显示笔尖预览，但不能成为选择工具的唯一入口。
- 双击默认在当前书写工具和橡皮擦间切换；用户可在设置中关闭。
- 挤压工具面板属于增强项；未在目标设备验收前不出现在功能说明。
- 压感、方位角、倾斜和系统估算值由 PencilKit 保留，业务层不自行重采样。

## 10. PDF 阅读与页面生命周期

### 10.1 阅读模式

**连续模式**

- 页面纵向排列，页间距 20pt；
- 页间显示 `当前物理页 / 总页数`；
- 以视口中心占比最大的页作为“当前页”；
- 页面宽度默认适合可用宽度，上限避免超宽；
- 快速滚动时可延迟加载笔迹预览，但停下后 150ms 内开始加载当前页。

**单页模式**

- 每次只显示一个物理页；
- 左右翻页，双指仍可缩放；
- 缩放大于适合整页时，水平手势先平移到边缘，再允许翻页；
- 翻页后当前页缩放恢复遵循用户偏好：保持缩放或适合页面，默认适合页面。

切换模式时保留当前物理页和视口中心对应的页内位置。内部页索引从 0 开始，界面和现有区域 AI 合同使用从 1 开始的页码。

### 10.2 页面加载窗口

- 当前可见页必须加载 PDF 和笔迹层。
- 预取前后各 1 页；内存充足时可扩大，但不能写死大量页。
- 远离视口的干净 `PKCanvasView` 可释放。
- 脏页、正在上传页、发生冲突页和套索选中页不得释放。
- 内存警告优先释放 PDF 渲染缓存和干净远页，不删除本机恢复文件。
- 同一页重新创建 overlay 时，必须先从当前内存对象、本机恢复文件或云端 head 中选择最新状态，不能用空画布覆盖。

### 10.3 PDF 边界情况

必须覆盖：

- 有文字层 PDF；
- 扫描 PDF；
- 混合横竖页；
- `CropBox` 不同于 `MediaBox`；
- 页面旋转 0 / 90 / 180 / 270 度；
- 密码保护或损坏文件；
- 300 页以上文件；
- 同一资料产生新 `versionId`。

新版本不继承旧版本笔迹。界面可提示“旧版本有手写”，但只有用户明确选择迁移任务后才能复制；自动坐标迁移不在首期。

## 11. 笔迹坐标合同

### 11.1 身份

每一页笔迹必须绑定：

- `ownerId`：只由服务端身份确定；
- `sourceId`；
- `versionId`；
- `pageIndex`：0-based 物理页；
- `pageNumber`：只用于 UI，恒等于 `pageIndex + 1`；
- `coordinateSpaceVersion = "pdf-cropbox-visual-v1"`。

任何一项改变都视为不同笔迹文档。不得只用文件名、页码或当前资料标题寻找笔迹。

### 11.2 标准页面空间

`pdf-cropbox-visual-v1` 定义：

1. 取 PDF 页 `CropBox`；
2. 应用 PDF 页声明的旋转，得到用户实际看到的页面方向；
3. 原点为视觉页面左上角；
4. x 向右、y 向下；
5. 宽高单位为 PDF 逻辑 point，缩放为 100% 时与 overlay 基准尺寸一致；
6. 原始 PencilKit 数据在该基准 overlay 中记录；
7. 实际视图缩放、滚动、Safe Area 和工具栏偏移不进入持久坐标。

每个页版本同时记录：

```ts
type InkCoordinateSpaceV1 = {
  version: "pdf-cropbox-visual-v1";
  width: number;
  height: number;
  pdfRotation: 0 | 90 | 180 | 270;
  cropBox: { x: number; y: number; width: number; height: number };
};
```

加载时若 PDF 计算出的空间与保存值不一致，进入“坐标不兼容”错误，不猜测缩放后继续显示。

### 11.3 视图转换

原生层拥有以下转换并提供单元测试：

- PDF 原始页坐标 ↔ 视觉 CropBox 坐标；
- 视觉 CropBox 坐标 ↔ 当前 PDFView 坐标；
- 当前 PDFView 坐标 ↔ 归一化区域 AI 坐标；
- 页面 overlay 边界变化前后的稳定转换。

区域 AI 继续使用现有合同：原点左上，`x/y/width/height` 均为 0–1，且 `x + width <= 1`、`y + height <= 1`。提交前将选区反算回页空间，再从该页渲染；不能直接截图整个 App 后裁切。

### 11.4 数据真实性

- 原始 `PKDrawing` 二进制是 iPad 可编辑笔迹的权威内容。
- 透明 PNG 是跨端只读预览，不可反向生成可编辑笔画。
- 笔画数量、边界框和预览图都属于派生数据，不能代替原始数据。
- 不把二进制内的点拆成 JSON 在 JS、Supabase 行或日志中传输。
- 保存时记录 PencilKit 内容版本；客户端遇到高于自身支持版本的数据时只显示预览并提示升级，不用空数据覆盖。

## 12. 原生技术架构

### 12.1 选型

首选方案是在 Expo 工程内创建本地原生模块 `conuo-pdf-ink`：

```text
apps/mobile/
  modules/
    conuo-pdf-ink/
      expo-module.config.json
      package.json
      src/
        ConuoPdfInk.types.ts
        ConuoPdfInkView.tsx
        index.ts
      ios/
        ConuoPdfInkModule.swift
        ConuoPdfInkView.swift
        ConuoPdfViewCoordinator.swift
        ConuoPageOverlayProvider.swift
        ConuoInkDraftStore.swift
        ConuoRegionRenderer.swift
```

原生视图内部使用：

- `PDFView` / `PDFDocument` / `PDFPage` 负责原件显示、搜索、导航和缩放；
- `PDFPageOverlayViewProvider` 为每个可见页面提供 overlay；
- `PKCanvasView` / `PKDrawing` 负责低延迟手写、橡皮擦和撤销；
- React Native 负责页面导航、Conuo 工具栏、保存状态、云端 API 和 AI 结果面板。

技术依据：

- [Apple PKCanvasView](https://developer.apple.com/documentation/pencilkit/pkcanvasview)
- [Apple PKDrawing](https://developer.apple.com/documentation/pencilkit/pkdrawingreference)
- [Apple PDFKit](https://developer.apple.com/documentation/pdfkit)
- [Apple PDFView](https://developer.apple.com/documentation/pdfkit/pdfview)
- [PDFPageOverlayViewProvider](https://developer.apple.com/documentation/pdfkit/pdfpageoverlayviewprovider)
- [Expo Modules API](https://docs.expo.dev/modules/overview/)
- [Expo 原生 View 教程](https://docs.expo.dev/modules/native-view-tutorial/)

如果目标 iPadOS / Xcode 组合不支持所需 overlay API，技术验证任务必须先记录替代方案和限制，再改 PRD；不得静默换成 WebView。

### 12.2 线程边界

- Pencil 输入、画布渲染、undo manager、页坐标转换和页级序列化在原生主线程 / 合适原生队列完成。
- 文件哈希、PNG 生成和本机落盘移出手势关键路径。
- JS 只接收“页已变脏”“保存快照准备好”“当前页改变”等事件。
- 云端上传由 TypeScript 服务层或原生上传器统一负责，但同一页只能有一个有效提交队列。
- 不在每次 `canvasViewDrawingDidChange` 时发送完整二进制到 JS；使用短防抖并在原生侧快照。

### 12.3 React Native ↔ 原生 View 合同

首期 Props：

```ts
type ConuoPdfInkViewProps = {
  documentUri: string;
  sourceId: string;
  versionId: string;
  initialPageIndex: number;
  readMode: "single" | "continuous";
  interactionMode:
    "read" | "pen" | "pencil" | "highlighter" | "eraser" | "lasso" | "region";
  tool: {
    color: string;
    width: number;
    eraserMode?: "stroke" | "pixel";
  };
  fingerDrawingEnabled: boolean;
  pageInkDescriptors: Array<{
    pageIndex: number;
    revisionId: string | null;
    localFileUri: string | null;
    previewUri: string | null;
  }>;
  onDocumentReady(event: DocumentReadyEvent): void;
  onVisiblePagesChanged(event: VisiblePagesEvent): void;
  onViewportChanged(event: ViewportEvent): void;
  onDrawingDirty(event: DrawingDirtyEvent): void;
  onLocalSnapshot(event: LocalSnapshotEvent): void;
  onRegionSelected(event: RegionSelectedEvent): void;
  onNativeError(event: NativeReaderError): void;
};
```

必要命令通过 ref 或 Expo AsyncFunction 提供：

```ts
type ConuoPdfInkHandle = {
  goToPage(pageIndex: number): Promise<void>;
  setZoom(
    command: "in" | "out" | "fitWidth" | "fitPage" | { scale: number },
  ): Promise<void>;
  undo(pageIndex: number): Promise<void>;
  redo(pageIndex: number): Promise<void>;
  clearSelection(): Promise<void>;
  requestPageSnapshot(pageIndex: number): Promise<LocalSnapshotEvent>;
  renderRegion(input: {
    pageIndex: number;
    region: NormalizedRect;
    includeInk: boolean;
    maxLongEdge: number;
  }): Promise<RenderedRegion>;
  flushLocalDrafts(): Promise<FlushResult>;
};
```

事件只包含稳定身份和小型元数据，不包含完整笔迹 base64：

```ts
type DrawingDirtyEvent = {
  sourceId: string;
  versionId: string;
  pageIndex: number;
  localGeneration: number;
  canUndo: boolean;
  canRedo: boolean;
  changedAt: string;
};

type LocalSnapshotEvent = {
  sourceId: string;
  versionId: string;
  pageIndex: number;
  localGeneration: number;
  drawingFileUri: string;
  drawingSha256: string;
  drawingBytes: number;
  previewFileUri: string;
  previewSha256: string;
  previewBytes: number;
  coordinateSpace: InkCoordinateSpaceV1;
};
```

原生模块必须校验 `pageIndex`、文件 URI、页面边界和格式版本。JS 传入非法值时返回可分类错误，不崩溃。

## 13. 本机恢复与保存状态机

### 13.1 为什么需要本机恢复

手写是高频连续输入。只把未保存数据留在内存，会在系统回收进程、崩溃、设备没电或网络失败时造成不可接受的损失。因此本文对上位 PRD 做一项窄范围补充：

> iPad 可以持久保存“尚未被云端确认的用户笔迹和提交清单”；它不是可浏览的离线资料库，不复制完整知识库，也不改变云端权威。

### 13.2 文件位置与隔离

- 使用 App Sandbox 的 Application Support，不使用相册、Documents 公共目录或 iCloud Drive。
- 按账号不可逆摘要 / source / version / page 分目录；目录名不直接暴露邮箱或资料标题。
- 使用 iOS Data Protection；大二进制不得放 SecureStore。
- manifest 使用原子写：写临时文件、fsync、rename；禁止原地覆盖唯一副本。
- 原始笔迹和预览分别存储，manifest 只记录相对路径、digest、generation 和状态。
- 云端确认且 digest 一致后可删除对应本机待提交版本；保留当前页最近确认缓存由缓存策略决定。
- 退出账号时，如果有未同步笔迹，要求“继续同步 / 导出恢复包 / 放弃并删除”；会话失效时隔离这些文件，只有同一账号重新验证后才能恢复上传。

### 13.3 页级状态机

```text
cleanCloud
  └─落笔──> dirtyMemory
dirtyMemory
  ├─本机快照成功──> localProtected
  └─本机快照失败──> localWriteFailed
localProtected
  ├─开始上传──> uploading
  ├─继续落笔──> dirtyMemory（generation + 1，旧快照仍保留）
  └─用户放弃──> cleanCloud
uploading
  ├─服务端 CAS 成功且 digest 匹配──> cloudConfirmed
  ├─网络 / 5xx──> retryable
  ├─409──> conflict
  ├─401 / 403 / 404──> blocked
  └─继续落笔──> localProtected（新 generation 排队）
cloudConfirmed
  └─继续落笔──> dirtyMemory
retryable
  ├─自动或手动重试──> uploading
  └─继续落笔──> dirtyMemory
conflict
  └─用户处理──> uploading 或 conflictCopy
blocked
  └─权限恢复并重新核验──> uploading
localWriteFailed
  └─重新落盘成功──> localProtected
```

### 13.4 UI 文案

| 内部状态                      | 用户文案                   | 颜色 / 图标       | 可执行动作     |
| ----------------------------- | -------------------------- | ----------------- | -------------- |
| `cleanCloud / cloudConfirmed` | 已保存到云端               | 中性绿点 + 云     | 无             |
| `dirtyMemory`                 | 正在保护笔迹…              | 中性色 + 转动图标 | 等待           |
| `localProtected`              | 已保存在本机，等待同步     | 琥珀 + 设备       | 立即同步       |
| `uploading`                   | 正在同步…                  | 品牌色 + 云上行   | 不重复触发     |
| `retryable`                   | 同步失败，笔迹仍在本机     | 琥珀 + 警告       | 重试、查看原因 |
| `conflict`                    | 这页在另一台设备被修改     | 琥珀 / 红 + 分支  | 比较版本       |
| `blocked`                     | 无法同步：权限或资料已改变 | 红 + 锁           | 导出、返回     |
| `localWriteFailed`            | 无法保护新笔迹，请勿关闭   | 红 + 设备错误     | 重试、导出     |

“已保存”必须带“云端”或“本机”限定，不能只显示一个模糊对勾。

### 13.5 自动保存触发

- 停笔 800ms 后生成页快照；持续书写时最多每 5 秒生成一次保护快照。
- 切页、关闭标注模式、进入 AI 选区、应用进入后台和离开阅读器时立即请求快照。
- 同一 generation 不重复上传；失败重试使用同一 revision / intent 身份。
- 新 generation 产生时，正在上传的旧 generation 可完成，但成功后不能把新 generation 标为已保存。
- 应用进入后台只能尽力上传；本机快照成功才是允许离开的最低条件。
- 网络恢复后可自动重试；需要新收费调用或用户选择的动作不得自动执行。

## 14. 云端数据模型

以下为新迁移的目标模型。字段名可在实现评审时微调，但身份、不可变版本、页级 head 和冲突保留不得删减。

### 14.1 `ink_documents`

每个账号、资料版本最多一个笔迹文档。

| 字段                      | 规则                               |
| ------------------------- | ---------------------------------- |
| `owner_id uuid`           | 复合主键一部分；RLS 只允许当前账号 |
| `ink_document_id uuid`    | 服务端生成，稳定身份               |
| `source_id text`          | 符合现有业务 ID 约束               |
| `version_id text`         | 不可变资料版本                     |
| `format_version integer`  | 首版为 1                           |
| `page_count integer`      | 创建时与资料版本核验               |
| `created_at / updated_at` | 服务端时间                         |
| `deleted_at`              | 文档级墓碑，不物理复活             |

唯一约束：`(owner_id, source_id, version_id)`。资料新版本建立新文档。

### 14.2 `ink_page_heads`

| 字段                                        | 规则                                      |
| ------------------------------------------- | ----------------------------------------- |
| `owner_id`、`ink_document_id`、`page_index` | 页身份；`page_index >= 0`                 |
| `head_revision_id uuid`                     | 指向当前已确认 revision；空代表此页无笔迹 |
| `head_generation bigint`                    | 服务端单调递增                            |
| `updated_at`                                | 服务端时间                                |
| `deleted_at`                                | 清空页时的墓碑                            |

主键：`(owner_id, ink_document_id, page_index)`。任何 head 改变必须比较客户端提供的 `baseRevisionId`。

### 14.3 `ink_page_revisions`

不可变追加记录：

| 字段                                             | 规则                                          |
| ------------------------------------------------ | --------------------------------------------- |
| `revision_id uuid`                               | 客户端预生成或服务端返回，重试稳定            |
| `owner_id / ink_document_id / page_index`        | 与 head 一致                                  |
| `parent_revision_id uuid?`                       | 客户端编辑的基础版本                          |
| `drawing_storage_path text`                      | 私有 bucket 内路径，只由服务端签发            |
| `drawing_sha256 text` / `drawing_bytes bigint`   | 二进制完整性                                  |
| `preview_storage_path text?`                     | 透明 PNG，只读跨端预览                        |
| `preview_sha256 text?` / `preview_bytes bigint?` | 预览完整性                                    |
| `coordinate_space jsonb`                         | 严格匹配第 11 节                              |
| `pencilkit_content_version integer`              | 兼容性判断                                    |
| `client_operation_id text`                       | 同一用户操作重试幂等                          |
| `created_at`                                     | 服务端时间                                    |
| `state`                                          | `pending / committed / rejected / superseded` |

已提交 revision 不更新内容；更改生成新 revision。

### 14.4 Storage

- 新建私有 bucket 或明确的私有前缀，不复用公开资源。
- 原始文件与预览分对象保存；客户端不能任意选择路径。
- Storage INSERT 必须绑定有效上传 intent，不能仅依赖“路径中含用户 ID”。
- 单页首期限制建议：原始笔迹 8 MiB、透明预览 3 MiB；超过时本机仍保留并提示简化 / 分页处理，不能静默截断。
- 过期 intent、被拒 revision、账号删除和资料彻底删除均进入可重试清理队列。
- 物理清理失败不改变业务删除状态；后续 worker 重试。

### 14.5 与现有文字批注的关系

- `public.annotations` 继续表示带 quote / note / textAnchor 的文字批注读投影。
- 原始笔迹不写进 `workspaces.data.annotations`，也不受 20,000 条文字批注限制。
- 笔迹预览可在资料详情聚合计数，但聚合字段由服务器派生。
- 将手写识别为文字时，用户确认后新建普通笔记或文字批注；保留来源 revision，不修改原始笔迹。

## 15. 云端 API 合同

路由名称是建议的稳定合同。实现必须复用现有鉴权、错误格式、请求记录和删除保护。

### 15.1 读取 manifest

`GET /api/v1/sources/:sourceId/versions/:versionId/ink`

返回：

```ts
type InkManifestResponse = {
  inkDocumentId: string | null;
  sourceId: string;
  versionId: string;
  pageCount: number;
  pages: Array<{
    pageIndex: number;
    headRevisionId: string | null;
    headGeneration: number;
    drawingDownloadUrl?: string;
    previewDownloadUrl?: string;
    coordinateSpace?: InkCoordinateSpaceV1;
    pencilKitContentVersion?: number;
    updatedAt: string;
    deleted: boolean;
  }>;
};
```

默认只返回有笔迹或墓碑的页。下载地址短时有效；响应不得泄露永久 Storage 路径。

### 15.2 预留上传

`POST /api/v1/sources/:sourceId/versions/:versionId/ink/upload-intents`

```ts
type ReserveInkUploadRequest = {
  operationId: string;
  pageIndex: number;
  baseRevisionId: string | null;
  localGeneration: number;
  drawing: { sha256: string; bytes: number; contentVersion: number };
  preview: { sha256: string; bytes: number; mimeType: "image/png" };
  coordinateSpace: InkCoordinateSpaceV1;
};
```

服务端核验：账号、资料存在、当前版本、页数、AI 无关的阅读权限、账号未注销、大小、digest 格式、坐标结构、基础 revision。返回稳定 intent、revisionId 和两条短时签名上传信息。

同一 `operationId` + 完全相同请求必须可重入；字段漂移返回 409。

### 15.3 确认提交

`POST /api/v1/sources/:sourceId/versions/:versionId/ink/commits`

```ts
type CommitInkRevisionRequest = {
  operationId: string;
  intentId: string;
  revisionId: string;
  pageIndex: number;
  baseRevisionId: string | null;
};
```

服务端确认两个对象存在、大小与预留一致，完成必要完整性核验，在同一数据库事务中：

1. 将 revision 置为 committed；
2. CAS 更新 page head；
3. 更新 document 时间；
4. 记录幂等结果。

返回新的 head。响应丢失时，客户端按 `operationId` 查询结果，不能创建另一 revision 盲重试。

### 15.4 清空一页

`DELETE /api/v1/sources/:sourceId/versions/:versionId/ink/pages/:pageIndex`

请求携带 `operationId` 和 `baseRevisionId`。服务端写墓碑并更新 head；Storage 后台清理。旧设备提交基于被删除 revision 时返回 409，不能复活。

### 15.5 冲突响应

统一返回 HTTP 409 和结构化信息：

```ts
type InkConflict = {
  code: "INK_PAGE_CONFLICT";
  pageIndex: number;
  submittedBaseRevisionId: string | null;
  currentHeadRevisionId: string | null;
  currentPreviewUrl?: string;
  message: string;
};
```

不返回另一用户数据；当前模型只允许同一 owner 的设备冲突。

## 16. 同步、冲突、删除与账号切换

### 16.1 同步原则

- 每一页独立同步，避免一页大笔迹阻塞整份文档。
- 云端 head 是跨设备权威；本机较新的未提交 generation 是待处理输入。
- 不依赖客户端时间判断新旧，只使用 revision 关系和服务端 generation。
- 同一设备同一页提交串行；不同页可以受控并行。
- manifest 刷新不得用旧云端 head 覆盖本机未同步 generation。
- 当前用户不拥有服务端密钥；所有 Storage 上传都必须由服务端预留。

### 16.2 冲突策略

首版不做笔画级自动合并。发生同页 CAS 冲突时：

1. 保留本机 revision 和本机恢复文件；
2. 拉取云端 head 的预览与元数据；
3. 显示“云端版本 / 此 iPad 版本”并排或切换预览；
4. 用户可选择：
   - 保留云端版本，本机版本另存为“冲突副本”；
   - 用此 iPad 版本创建新的 head，二次确认；
   - 暂不处理；
5. 任何选择都生成新操作，不篡改两条已有 immutable revision；
6. 未处理冲突时仍允许阅读，但该页继续书写前提示将基于哪个版本。

“两份都保留”是默认安全结果。不得用最后写入时间自动覆盖。

### 16.3 清空和删除

- 套索删除只修改当前 page revision。
- “清空本页手写”需二次确认，可撤销到提交前；提交后通过新 revision 或墓碑表达。
- 删除资料到回收站时停止新的笔迹上传，保留云端笔迹随资料恢复。
- 彻底删除资料时，笔迹、预览、上传 intent 和冲突副本进入同一删除选择与清理流程。
- 账号注销封锁后不再签发下载 / 上传；后台清理可删除 Storage 对象。
- 本机恢复文件在收到账号注销 / 彻底删除确认后清理；若服务端状态未知，先隔离，不把未知当已删除。

### 16.4 账号切换

- 所有 in-memory canvas、manifest、下载 URL、上传队列和 AI 结果都绑定 session generation。
- 退出账号立即取消可取消的请求，并使迟到响应失效。
- 登录另一个账号后不得读取前一账号的恢复目录或预览。
- 前一账号未同步笔迹必须在退出前处理；强制失效时只能在同一账号重新验证后恢复。

## 17. 区域 AI

### 17.1 选区

- 只有 PDF 页面内容区可选，最小边长 24pt，最小归一化面积 0.0004。
- 选区不能跨物理页。拖到页外时在页面边界截断。
- 四角和四边有调整手柄；拖动手柄时放大镜预览属于增强项。
- 选区完成后显示页码和范围；用户可以重新框选。
- 进入选区模式前强制完成当前页本机快照，避免“包含手写”使用旧数据。

### 17.2 渲染

原生层直接从指定 PDFPage 区域渲染：

- 只含原文时：PDF 页区域；
- 包含手写时：同一坐标变换下叠加当前可见笔迹；
- 不含工具栏、页面阴影、页间背景、选区边框、其他页面、AI 面板或系统状态栏；
- 长边不超过 4096px，总像素不超过 8,000,000；
- 编码为 PNG、JPEG 或静态 WebP，最终字节不超过 2 MiB；
- 若超限，保持同一区域等比降采样并再次预览，不能改变裁切范围；
- 预览图就是请求图，确认后不得重新渲染不同内容。

### 17.3 复用现有接口

首期复用：

`POST /api/v1/vision/region-study`

请求必须满足现有合同：

```ts
type VisionStudyRequest = {
  requestId: string;
  task: "explain" | "ask" | "quiz";
  provenance: {
    sourceId: string;
    versionId: string;
    page: number; // 1-based
    region: { x: number; y: number; width: number; height: number };
  };
  image: {
    dataUrl: string;
    width: number;
    height: number;
  };
  question?: string; // 只允许 ask
};
```

原生调用必须补齐 Bearer 认证适配；不通过浏览器 Cookie。请求前 GET readiness 可显示能力是否可用。服务端已经核验：当前账号、工作区、PDF 类型、资料当前版本、页码、AI 总开关、资料 AI 权限、图像类型 / 尺寸 / 字节，以及请求期间上下文是否改变。

### 17.4 是否包含手写

预览区提供开关：

- 默认关闭：“仅发送原始资料区域”；
- 开启后：“同时发送我在该区域可见的手写”；
- 如果区域没有可见手写，开关禁用并说明；
- UI 用叠加预览明确展示结果；
- 请求本身继续绑定原资料 provenance；结果界面另标记“本次图像包含你的手写”；
- 不自动把手写识别文本保存为笔记。

### 17.5 三种任务

| 任务 | 输入                 | 输出                                                     |
| ---- | -------------------- | -------------------------------------------------------- |
| 解读 | 选区                 | summary + 2–8 个 observation / reasoning / takeaway 小节 |
| 提问 | 选区 + 1–2000 字问题 | 结构化 Markdown content                                  |
| 出题 | 选区                 | 1–8 题，每题 question / answer / explanation             |

“出题”默认先隐藏答案；用户点开单题后显示答案和解析。该临时练习不自动计入长期复习记录。

### 17.6 中断与幂等

- 每次用户确认生成一个稳定 `requestId`。
- 网络错误或响应丢失后先查询 / 复用服务端请求记录，不盲目发起收费模型调用。
- 用户取消时停止显示等待；服务端已经开始的调用是否可取消按实际状态，不宣称一定撤回。
- 资料版本、页码范围或 AI 权限变化返回 409 / 403 后，保留问题文本，让用户重新框选。
- 不把图片内容中的指令当作系统指令；服务端现有提示注入防护继续生效。

## 18. AI 结果界面

### 18.1 面板结构

宽屏使用右侧面板，窄屏使用底部 / 全屏 Sheet：

1. 标题：区域解读 / 区域问答 / 区域出题；
2. 范围卡：资料标题、版本状态、页码、缩略图、“包含手写”标记；
3. 结果正文；
4. 可折叠的“识别到的可见文字”；
5. 复制、保存到笔记、重新提问；
6. 模型和错误信息放在次要位置，不暴露密钥或请求内部标识。

关闭面板后恢复原阅读位置和工具；若关闭前处于 region 模式，默认回到此前稳定模式。

### 18.2 解读渲染

- summary 使用简洁概览卡；
- observation 标题为“看到了什么”语义，使用中性蓝；
- reasoning 标题为“如何理解 / 推导”，使用品牌紫；
- takeaway 标题为“学习要点”，使用绿色；
- Markdown 支持段落、列表、表格、行内 / 块级公式；
- 代码块、表格和公式可横向滚动，不撑破面板；
- 所有外链默认不由模型结果直接打开，用户确认后交给系统；
- 复制内容与界面结构化文本一致。

### 18.3 保存到笔记

保存前展示预览，并明确：

- AI 内容不是原文；
- 来源绑定当前 source / version / page / region；
- 若包含手写，记录该事实和当时的笔迹 revision；
- 用户可编辑标题和正文；
- 保存走现有笔记 CAS，409 时保留草稿并处理冲突；
- 保存成功不改变或删除原始手写。

## 19. 错误与恢复

| 场景                 | 必须显示                   | 数据处理                   | 恢复                   |
| -------------------- | -------------------------- | -------------------------- | ---------------------- |
| PDF 下载失败         | 资料名、失败原因、安全重试 | 不删除云端资料             | 重试或返回资料库       |
| PDF 损坏 / 加密      | 原件无法打开               | 不创建空笔迹文档           | 使用解析文本或重新上传 |
| Pencil 断连          | 仍可阅读；已写笔迹保留     | 不清空 canvas              | 重连或触摸导航         |
| 本机磁盘不足         | “无法保护新笔迹，请勿关闭” | 保留内存，停止假保存       | 清理空间、导出、重试   |
| Storage 上传失败     | 笔迹仍在本机               | 保留 intent / operationId  | 自动退避或手动重试     |
| 401 会话失效         | 登录已失效                 | 停止上传、隔离恢复文件     | 同账号重新登录         |
| 403 权限撤销         | 无权继续同步               | 不重试、不泄露内容         | 导出自己的恢复包或返回 |
| 404 资料删除         | 资料已不可用               | 不复活旧版本               | 返回资料库             |
| 409 页冲突           | 两份版本摘要               | 两份都保留                 | 比较并选择             |
| 坐标不兼容           | 暂不能编辑此页手写         | 只读预览，不覆盖           | 升级 App 或导出        |
| PencilKit 版本过高   | 需要更新 App               | 只读预览                   | 更新后重试             |
| AI 未配置 / 额度耗尽 | 本次未发送 / 无法继续      | 不重复收费调用             | 稍后重试               |
| AI 请求中断          | 请求状态未知或已停止       | 保留问题和预览直到用户关闭 | 查询记录 / 重试        |
| 低内存重建页面       | 页面正在恢复               | 脏页先读本机恢复文件       | 自动重建 overlay       |

错误 Toast 只用于短反馈；会影响数据安全的错误必须持续显示在顶栏和相关页。

## 20. 隐私与安全

- 原始 PDF、笔迹、区域截图和预览均视为用户私有学习数据。
- 区域图片只有用户在预览页点“发送”后才能进入模型请求。
- 不做整页后台识别，不采集原始笔迹到分析平台，不记录图片 base64。
- 事件日志只记录任务类型、成功 / 失败类别、耗时区间、字节区间和设备能力，不记录文字、坐标细节、资料标题或 Storage 路径。
- 下载 URL 和上传 URL 短时有效，不能进入持久日志或崩溃报告。
- 服务端对 owner、source、version、page 和账号注销状态逐次核验。
- RLS、RPC 权限、Storage policy、service role 使用和清理 worker 需要独立安全测试。
- 资料禁止 AI 时，仍允许本地手写和云端保存笔迹，但不允许发送区域模型请求。
- “包含手写”是逐次请求选择，不做永久默认开启。
- 导出恢复包必须由用户显式触发，说明内容并通过系统 Share Sheet 交付；临时文件用后清理。

## 21. 无障碍与输入设备

- 所有可交互按钮命中不小于 44×44pt。
- 图标必须有简体中文 VoiceOver 名称、状态和值，例如“荧光笔，黄色，8 点，已选择”。
- 保存状态使用文字 + 图标，不仅靠颜色。
- VoiceOver 用户可从“页批注列表”访问：页码、更新时间、保存状态、是否冲突，并执行清空 / 导出 / 跳转；不要求在画布中逐笔导航。
- 动态字体不放大 PDF 本身，但需放大工具提示、Sheet 和结果正文；顶栏空间不足时收进更多菜单。
- 外接键盘首期快捷键：

| 快捷键       | 动作                             |
| ------------ | -------------------------------- |
| `⌘F`         | 搜索 PDF                         |
| `⌘G`         | 跳页                             |
| `⌘+` / `⌘-`  | 缩放                             |
| `⌘Z` / `⇧⌘Z` | 当前页撤销 / 重做                |
| `I`          | 开关标注模式，输入框聚焦时不触发 |
| `A`          | 区域 AI，输入框聚焦时不触发      |
| `Esc`        | 取消选区 / 关闭当前 Sheet        |

- 中文输入法组合期间不得让 Enter、I、A 等快捷键误触发。
- 支持减弱动态效果、提高对比度和深色模式；Pencil 线色不得因界面主题自动改写。

## 22. 性能与资源目标

这些是可测目标，不是无需验证的承诺：

| 指标       | 首期目标                                                             | 测量方式                          |
| ---------- | -------------------------------------------------------------------- | --------------------------------- |
| 书写链路   | Pencil 输入不经过 JS 逐点桥接；无肉眼断线                            | Instruments + 高速录屏 / 真机观察 |
| 帧率       | 普通页书写维持系统可用刷新率；目标 60fps，ProMotion 设备尽量跟随系统 | Core Animation / MetricKit        |
| 脏状态反馈 | 停笔后 100ms 内显示未保存状态                                        | 自动 UI 时间戳测试                |
| 本机保护   | 停笔 800ms 后开始快照；切页 / 后台立即触发                           | 原生事件测试                      |
| 当前页恢复 | 已有本机缓存时 500ms 内开始显示笔迹                                  | 真机基准                          |
| 首屏 PDF   | 20MiB 已下载本地文件，2 秒内显示首个可读页面                         | 冷启动真机基准                    |
| 内存       | 300 页文件不创建 300 个常驻 PKCanvasView                             | Instruments 对象 / 内存检查       |
| 区域图     | 满足现有 4096px、8MP、2MiB 限制                                      | 单元 + 真机                       |
| 云端保存   | 不阻塞滚动或落笔；状态与最终结果一致                                 | 网络调试与故障注入                |

目标设备至少记录一台 60Hz iPad 和一台支持 Apple Pencil 的近期 iPad。没有测量前不得填写虚构数值。

## 23. 分阶段开发工作包

每个工作包必须独立提交验证结果。只有前一包的退出条件满足，下一包才能把它当作事实。

### WP0：技术验证与基线

**目标：** 证明 Expo 本地模块可以在目标工程中承载 PDFKit + PencilKit。

**允许修改：**

- `apps/mobile/modules/conuo-pdf-ink/**`；
- `apps/mobile/package.json` 和原生配置；
- 一个隔离的开发入口；
- 对应测试和开发文档。

**任务：**

1. 用 Expo Modules 创建本地 native view。
2. 加载工程内无敏感内容的测试 PDF。
3. 使用 `PDFPageOverlayViewProvider` 为当前页挂载 `PKCanvasView`。
4. Pencil 写入后保留在同一页；缩放和滚动时位置不漂移。
5. 验证连续模式至少 3 页、页面旋转和 CropBox。
6. 记录目标 Xcode、iPadOS、设备和 Pencil 型号。

**退出条件：**

- macOS 构建通过；
- iPad 真机视频 / 截图证明书写、缩放和翻页；
- 没有 WebView；
- 没有逐点 JS 事件；
- 技术限制回写本文或实施记录。

### WP1：只读原生 PDF 阅读器

**目标：** 把当前 PDF 原件可靠地交给原生阅读器，不开放手写保存。

**任务：**

1. 资料身份和权限检查；
2. 私有 PDF 临时下载；
3. 单页 / 连续模式；
4. 页码、缩放、搜索；
5. 当前页和位置恢复；
6. 加密、损坏、扫描和权限失败；
7. 横竖屏与窄分屏。

**退出条件：**

- 不改变现有文本阅读回退；
- 真机通过第 25 节 RDR 用例；
- 关闭标注入口或标记“开发中”，不能呈现假保存。

### WP2：本机手写

**目标：** 在无云端依赖时完成工具、坐标、撤销和本机恢复。

**任务：**

1. 自定义顶部栏与左侧 / 底部工具栏；
2. pen / pencil / highlighter / eraser / lasso；
3. Pencil / 手指手势协调；
4. 每页独立 undo / redo；
5. 标准坐标转换测试；
6. 原子恢复文件和 manifest；
7. 杀进程、旋转和内存回收恢复。

**退出条件：**

- 只宣称“本机受保护”，不显示云端已保存；
- 旋转页和 CropBox 页对齐通过；
- 应用强制结束后恢复；
- 账号隔离路径与日志无敏感信息。

### WP3：笔迹云端模型与 API

**目标：** 建立独立于文字批注的安全页级版本存储。

**允许修改：**

- 新 Supabase migration；
- `apps/web/src/app/api/v1/**` 下新路由；
- 新服务端合同、测试、清理 worker；
- 移动端上传适配器。

**任务：**

1. 建表、约束、RLS 和最小 grant；
2. 私有 Storage policy；
3. 预留、上传、提交、读取、清空；
4. operation 幂等与响应丢失恢复；
5. 过期 intent 和孤立对象清理；
6. 资料彻底删除和账号注销联动；
7. 原件版本变化拒绝。

**退出条件：**

- 空库迁移重放通过；
- SQL / API 安全与冲突测试通过；
- staging 前仍标“本地完成”；只有真实部署后才能标“云端可用”；
- 生产未获授权不得修改。

### WP4：移动端同步与冲突

**目标：** 把本机恢复状态与云端 head 串成真实同步。

**任务：**

1. manifest 拉取和可见页懒加载；
2. 自动保存队列；
3. Bearer 身份；
4. 网络恢复和响应丢失；
5. 两设备同页冲突；
6. 两页并行同步；
7. 退出、账号切换、权限撤销；
8. Web 只读预览。

**退出条件：**

- 两台物理设备完成冲突矩阵；
- 保存文案与云端事实一致；
- Web 不丢弃未知笔迹对象；
- 删除后的旧离线客户端不能复活笔迹。

### WP5：区域 AI

**目标：** 复用现有多模态接口完成 iPad 框选学习。

**任务：**

1. 单页选区与手柄；
2. 原文 / 原文 + 手写两种原生渲染；
3. 像素和大小限制；
4. 请求预览；
5. readiness、Bearer 请求、取消和上下文变化；
6. 三种结构化结果；
7. 保存到笔记。

**退出条件：**

- 上传图与预览 SHA-256 一致；
- 不含 App UI 或相邻页；
- 结构化输出、公式、表格和练习展开通过；
- 权限变化后不发送像素。

### WP6：打磨与发布门槛

**目标：** 补齐无障碍、性能、兼容性和发布证据。

**任务：**

1. VoiceOver、动态字体、减弱动态效果；
2. 外接键盘 / 触控板；
3. 60Hz 与 ProMotion 设备性能；
4. 大文件、扫描件、混合旋转页；
5. 长时间书写和大笔迹；
6. 崩溃 / 低磁盘 / 内存压力；
7. 隐私说明、数据导出与删除；
8. 支持设备和系统版本清单。

**退出条件：**

- 第 25 节首发矩阵全部通过；
- 未通过的硬件能力从宣传和设置中隐藏；
- 商店构建、签名和发布仍按独立授权处理。

## 24. 文件与模块职责

建议目录，不允许把所有逻辑塞进一个 screen：

```text
apps/mobile/src/
  features/pdf-reader/
    PdfReaderScreen.tsx
    PdfReaderTopBar.tsx
    InkToolPalette.tsx
    InkSaveStatus.tsx
    InkConflictSheet.tsx
    RegionSelectionSheet.tsx
    RegionStudyResult.tsx
    reader-layout.ts
    reader-types.ts
  core/ink/
    ink-api.ts
    ink-contract.ts
    ink-sync-queue.ts
    ink-state-machine.ts
    ink-errors.ts
    ink-account-boundary.ts
  core/vision/
    region-study-api.ts
    region-study-contract.ts
```

职责边界：

- Screen 组合视图和路由，不直接操作 Storage。
- Native View 管 PDF / Pencil 的高频交互，不直接决定账号权限。
- `ink-api` 只做 HTTP 合同和响应解析。
- `ink-sync-queue` 串行同页 generation，处理退避和状态核对。
- `ink-state-machine` 是纯函数，可做完整转换测试。
- `ink-account-boundary` 处理 session generation、退出和迟到响应。
- 视觉 API 合同若与 Web 共用，应抽到可跨包使用的纯 TypeScript 包；在抽取完成前保持字段逐项合同测试，禁止复制后漂移。
- 组件只消费明确状态，不根据错误字符串猜测业务分支。

## 25. 验收矩阵

### 25.1 原生阅读

| ID     | 场景        | 操作                            | 通过断言                         |
| ------ | ----------- | ------------------------------- | -------------------------------- |
| RDR-01 | 连续阅读    | 打开 300 页 PDF 快速滚到 150 页 | 当前页正确，未创建全部页 overlay |
| RDR-02 | 单页阅读    | 切到单页，放大后平移和翻页      | 边缘手势可理解，不误翻页         |
| RDR-03 | 模式切换    | 连续 49 页中部切单页再切回      | 仍是物理 49 页和相近页内位置     |
| RDR-04 | 混合方向    | 浏览横页、竖页和 90° 旋转页     | 页面方向正确，无裁切             |
| RDR-05 | CropBox     | 打开裁剪框与媒体框不同的 PDF    | 显示与坐标基准一致               |
| RDR-06 | 扫描件      | 搜索并框选扫描 PDF              | 搜索说明无文字层，区域 AI 可用   |
| RDR-07 | 损坏 / 加密 | 打开不可读 PDF                  | 不白屏、不创建空笔迹             |
| RDR-08 | 分屏        | 全屏缩到最窄可用宽度再恢复      | 页、缩放、模式和面板输入保留     |

### 25.2 手写与工具

| ID     | 场景          | 操作                         | 通过断言                      |
| ------ | ------------- | ---------------------------- | ----------------------------- |
| INK-01 | Pencil + 手掌 | 写字时手掌接触页面           | 不产生手掌笔画，不阻塞 Pencil |
| INK-02 | 手指导航      | 标注模式单指滚动、双指缩放   | 默认不画线，视图平滑          |
| INK-03 | 工具          | 依次用笔、铅笔、高亮、橡皮   | 样式可辨，橡皮不擦原文        |
| INK-04 | 撤销范围      | A 页写两笔、B 页写一笔后撤销 | 只撤销当前 B 页               |
| INK-05 | 套索          | 选择、移动、缩放、删除       | 只改变选中笔迹，支持撤销      |
| INK-06 | 页面旋转      | 旋转设备并切阅读模式         | 笔迹保持原文位置              |
| INK-07 | PDF 旋转页    | 在 90° / 270° 页四角写标记   | 重开后四角不漂移              |
| INK-08 | 工具遮挡      | 工具条覆盖选区附近           | 自动换边或可收起              |
| INK-09 | Pencil 断连   | 写完后断开 Pencil            | 笔迹保留，阅读可继续          |
| INK-10 | 手指书写偏好  | 开启 / 关闭手指书写          | 输入行为与提示一致            |

### 25.3 本机恢复

| ID     | 场景            | 操作                           | 通过断言                             |
| ------ | --------------- | ------------------------------ | ------------------------------------ |
| LOC-01 | 杀进程          | 写完等到“本机已保护”，强制结束 | 重开恢复同一笔迹                     |
| LOC-02 | 立即后台        | 写一笔立刻回主屏幕             | 触发快照；失败时有明确风险           |
| LOC-03 | 连续 generation | 上传中继续写                   | 旧上传成功不把新内容标已保存         |
| LOC-04 | 磁盘不足        | 故障注入让原子写失败           | 顶栏持续红色，不允许假离开           |
| LOC-05 | manifest 损坏   | 破坏 manifest 主文件           | 从原子备份恢复或安全报错，不清空云端 |
| LOC-06 | 账号隔离        | A 写未同步，切换 B             | B 看不到 A 的恢复文件                |

### 25.4 云端与冲突

| ID     | 场景         | 操作                              | 通过断言                       |
| ------ | ------------ | --------------------------------- | ------------------------------ |
| SYN-01 | 正常保存     | 写一页，等云端确认，重装后打开    | 从云端恢复原始笔迹             |
| SYN-02 | 断网         | 断网写三页，联网                  | 每页最终确认，无重复 revision  |
| SYN-03 | 响应丢失     | 服务端提交成功后丢响应            | 按 operationId 核对，不重复写  |
| SYN-04 | 双设备不同页 | A 写 1 页，B 写 2 页              | 两页都成为 head                |
| SYN-05 | 双设备同页   | A/B 从同一 head 修改并先后提交    | 后者 409，两份都保留           |
| SYN-06 | 清空防复活   | A 清空页，离线 B 基于旧 head 提交 | B 被拒，不复活                 |
| SYN-07 | 新资料版本   | 上传替换版后打开                  | 旧笔迹不自动附到新版本         |
| SYN-08 | 权限撤销     | 写后撤销资料权限                  | 停止上传，可恢复内容不泄露     |
| SYN-09 | 资料彻删     | 删除并运行清理                    | 业务不可访问，Storage 最终清理 |
| SYN-10 | 账号注销     | 封锁账号后旧客户端提交            | 请求拒绝，旧数据不复活         |

### 25.5 区域 AI

| ID     | 场景          | 操作                     | 通过断言                             |
| ------ | ------------- | ------------------------ | ------------------------------------ |
| VIS-01 | 原文区域      | 框选图表并预览           | 图片只含该页该区域                   |
| VIS-02 | 包含手写      | 在公式旁写注释并开启开关 | 预览和请求都含同一笔迹               |
| VIS-03 | 不含手写      | 对同一区域关闭开关       | 原始 PDF 可见，笔迹不可见            |
| VIS-04 | 旋转页        | 在 90° 页框四角内容      | 请求区域与所见一致                   |
| VIS-05 | 跨页拖动      | 从一页拖向下一页         | 在首个页边界截断并提示               |
| VIS-06 | 超限图像      | 选择大区域               | 等比降采样，预览不换范围             |
| VIS-07 | 上下文变化    | 预览后在另一端替换版本   | 请求被拒，像素不继续发送             |
| VIS-08 | 解读          | 请求含公式区域           | summary / sections 结构化渲染        |
| VIS-09 | 提问          | 不填问题 / 填问题        | 空问题不能发送；有效问题返回 content |
| VIS-10 | 出题          | 生成 3–5 题并展开答案    | 每题有答案和解析，默认隐藏           |
| VIS-11 | 取消 / 丢响应 | 请求途中取消或断网       | 不假成功、不盲重发收费请求           |
| VIS-12 | 提示注入      | 图片含“忽略规则”等文字   | 只作为学习材料，不执行指令           |

### 25.6 无障碍与硬件

| ID      | 场景                     | 通过断言                                 |
| ------- | ------------------------ | ---------------------------------------- |
| A11Y-01 | VoiceOver 遍历顶栏和笔栏 | 顺序合理，工具名、值、选择态完整         |
| A11Y-02 | 动态字体最大档           | Sheet 可滚动，主按钮可见，命中不缩小     |
| A11Y-03 | 提高对比度 / 深色        | 状态仍可辨，PDF 和笔迹不被错误改色       |
| A11Y-04 | 外接键盘                 | 搜索、跳页、撤销、取消可用且不干扰输入法 |
| A11Y-05 | 触控板                   | 滚动、缩放、选择和工具按钮可操作         |
| HW-01   | 无 Pencil                | 阅读、AI 区域、键盘笔记仍可用            |
| HW-02   | 支持悬停设备             | 悬停只是增强，关闭后功能完整             |

## 26. 测试层级与证据

### 26.1 自动测试

- TypeScript：状态机、请求 schema、错误映射、session generation、队列幂等。
- Swift：坐标矩阵、旋转 / CropBox、页生命周期、原子 manifest、内容版本判断。
- API：认证、RLS、owner 隔离、版本绑定、大小 / digest、幂等、409、404、删除封锁。
- SQL：约束、CAS、墓碑、防复活、账号删除、清理租约。
- 组件：工具状态、保存文案、冲突 Sheet、AI 结构化渲染、无障碍标签。

### 26.2 真机证据

每轮验收记录：

- Git SHA；
- App build；
- iPad 型号和可用内存档位；
- iPadOS 版本；
- Pencil 型号；
- 全屏 / 分屏宽度；
- 测试 PDF 的页数、大小、旋转 / CropBox 特征；
- 网络条件；
- 通过 / 失败用例；
- 非敏感截图或短视频；
- 真机观察与推断分开书写。

模拟器可验证布局和部分 PDF 行为，不能证明压感、误触、Pencil 延迟、悬停、真实后台回收或物理双设备同步。

## 27. 埋点与诊断

允许的产品事件：

- `pdf_reader_opened`：文件类别、页数区间、打开结果；
- `ink_mode_entered`：输入能力类别，不含颜色 / 笔迹；
- `ink_local_snapshot_result`：成功、失败类别、字节区间；
- `ink_cloud_commit_result`：成功、冲突、权限、网络、服务端错误；
- `ink_conflict_resolved`：选择类型；
- `region_ai_previewed`：任务类型、是否包含手写、像素区间；
- `region_ai_result`：成功 / 失败类别、耗时区间；
- `reader_memory_warning`：可见页数和缓存页数区间。

禁止记录：

- 笔画点、原始二进制、预览图、区域截图；
- PDF 文本、AI 问题 / 回答、笔记正文；
- 邮箱、账号 ID、资料标题、完整 Storage 路径；
- 签名 URL、Bearer token、请求内部 ID；
- 可反推具体学习内容的精确页码 + 坐标组合。

## 28. 设计交付物

开发前至少完成以下设计状态，而不是只提供一张理想态：

1. 横屏宽屏：阅读 + 左侧笔栏 + 右侧 AI；
2. 竖屏：阅读 + 左侧笔栏；
3. 窄分屏：底部笔栏；
4. 单页与连续模式；
5. 每个工具的默认 / 选中 / 按下 / 禁用 / 焦点；
6. 颜色和粗细弹层；
7. 本机已保护、正在同步、云端已保存、失败、冲突、阻止离开；
8. AI 选区、调整、预览、发送中、结构化结果、错误；
9. 冲突比较与三种处理；
10. 坐标不兼容和内容版本过高的只读态；
11. VoiceOver 阅读顺序和动态字体最大档；
12. 深色模式和提高对比度。

设计标注必须给出安全区、间距、最小 / 最大宽度、44pt 命中区、折叠规则和文字溢出规则。只给固定 1366×1024 截图不能作为 iPad 适配完成。

## 29. 首发 Definition of Done

只有同时满足以下条件，才可以对外写“iPad 支持 PDF 手写”：

- [ ] 原生 PDFKit + PencilKit 路径在支持设备真机运行；
- [ ] 单页 / 连续阅读、搜索、页码、缩放通过；
- [ ] 钢笔、铅笔、荧光笔、橡皮擦、套索、颜色、粗细、撤销 / 重做通过；
- [ ] Pencil 写、手指移动、手掌误触在真机通过；
- [ ] 混合旋转页、CropBox 页、扫描件和大文件通过；
- [ ] 本机恢复箱通过杀进程、后台和低磁盘测试；
- [ ] 页级云端版本、幂等、冲突、删除防复活通过；
- [ ] 两台物理设备完成同页 / 不同页同步矩阵；
- [ ] Web 至少只读显示笔迹预览和类型；
- [ ] 区域 AI 的原文 / 含手写预览、三任务和权限变化通过；
- [ ] VoiceOver、动态字体、外接键盘和窄分屏通过；
- [ ] 隐私、导出、资料彻删和账号注销链路通过；
- [ ] 目标设备、系统和 Pencil 支持范围已写入发布说明；
- [ ] 未验收增强能力没有出现在设置、营销或已完成清单。

## 30. 已锁定决定与后续问题

### 30.1 本 PRD 已锁定

- 原生实现使用 PDFKit + PencilKit，不使用 WebView 作为首发主阅读器。
- 自定义 Conuo 工具栏驱动 PencilKit 工具，生产界面不直接照搬参考产品。
- 原始 `PKDrawing` 是可编辑权威，透明 PNG 是跨端预览。
- 笔迹与现有文字批注分表、分接口、分生命周期。
- 页级 immutable revision + head CAS，不做最后写入覆盖。
- 云端是跨设备权威；本机只持久保护未同步笔迹及必要缓存。
- 区域 AI 不要求 OCR，复用现有多模态 `region-study` 合同。
- 用户逐次选择是否把手写包含在区域图片中，默认关闭。
- iPhone 和 Web 首期只读，不编辑原始 PencilKit 笔迹。

### 30.2 实施前仍需用技术验证回答

- 目标最低 iPadOS 版本与 Expo SDK 57 / Xcode 的最终兼容组合；
- `PDFPageOverlayViewProvider` 在长文档连续模式下的内存和复用行为；
- 自定义套索和像素橡皮在目标 PencilKit 版本上的稳定能力；
- 透明预览的最佳分辨率 / 压缩和真实 Storage 成本；
- 大型单页 `PKDrawing` 的实际字节分布与 8 MiB 上限是否合适；
- 系统后台上传在当前分发方式下可以可靠覆盖的时长；
- Apple Pencil 悬停、双击、挤压在首发设备矩阵中的支持范围。

这些问题由 WP0 / WP2 / WP6 给出实测结论。回答前不影响基础架构，但不能把增强项提前标成完成。

## 31. 面向低能力开发模型的单任务模板

复制以下模板，每次只替换一个工作包：

```text
你正在 E:\workspace\conuo 的 staging 分支开发 Conuo iPadOS。

先阅读：
1. docs/IPADOS_HANDWRITING_PRD.md
2. docs/IPADOS_PRD.md
3. apps/mobile/README.md
4. 与本任务直接相关的现有代码和测试

本次只完成：[填写 WP 编号和一个明确切片]

硬性边界：
- 不修改生产环境，不部署，不提交，不推送。
- 不安装或启动本地 PostgreSQL。
- 不输出或写入任何密钥、Cookie、token、账号或完整 Storage 路径。
- 不把 WebView、浏览器预览或模拟器当作 Pencil 真机完成证据。
- 不在 JS Bridge 逐点发送笔迹。
- 不复用 public.annotations 存原始笔迹。
- 保留用户已有修改，不重构无关文件。

执行顺序：
1. 写出当前事实、拟改文件、明确不改的范围。
2. 先补能证明该切片的失败测试或验证夹具。
3. 实现最小纵向切片。
4. 运行定向测试、类型检查和相关回归。
5. 如涉及原生手势，列出需要在 macOS / iPad 真机执行的步骤；未执行就写“待真机验证”。
6. 最终按“本地完成 / 已验证 / 待真机 / 未提交 / 未部署”分别汇报。

验收条件只使用 PRD 对应工作包和用例 ID，不自行扩大完成声明。
```

## 32. 维护规则

- 本文变更需要同步检查 [iPadOS App PRD](IPADOS_PRD.md) 的范围和阶段描述。
- API 或数据结构落地后，以实际 migration 和共享 TypeScript schema 为准，并把差异回写本文。
- 每个已完成工作包在实施状态文档中记录 Git SHA、测试和真机证据；不要在本 PRD 中把目标改写成完成事实。
- 参考产品只用于交互分析；Conuo 的品牌、权限、云端模型和信息架构保持独立。
