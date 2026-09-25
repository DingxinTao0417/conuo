/**
 * Homepage copy. Every string visible on the landing lives here so the zh/en
 * versions stay structurally identical (enforced by the LandingCopy type and
 * copy.test.ts). Product claims mirror README/PRD scope: no invented metrics,
 * testimonials or pricing, and unreleased platforms are labelled as such.
 */
import type { Lang } from "./auth-copy";

export type { AuthMode, Lang } from "./auth-copy";

/** Inline text may contain `**bold**` and `{n}` citation tokens (n = paragraph number). */
export type AnswerBlock =
  | { kind: "p"; text: string }
  | { kind: "math"; tex: string }
  | { kind: "list"; items: string[] }
  | { kind: "notice"; text: string };

export type DemoQuestion = { id: string; label: string; answer: AnswerBlock[] };
export type DocParagraph = { id: number; text: string; tex?: string; after?: string };
export type PlatformStatus = "available" | "dev" | "planned";

export interface LandingCopy {
  meta: { langName: string; switchTo: string; switchLabel: string; skip: string };
  nav: {
    links: { id: string; label: string }[];
    login: string;
    start: string;
    menu: string;
    closeMenu: string;
    home: string;
  };
  hero: {
    badge: string;
    titleLines: [string, string];
    highlight: string;
    lead: string;
    primary: string;
    secondary: string;
    flow: string[];
    scroll: string;
    bridgeEyebrow: string;
    bridge: [string, string];
  };
  story: {
    eyebrow: string;
    title: string;
    steps: { title: string; body: string; points: string[] }[];
    stage: {
      window: string;
      files: { name: string; kind: "pdf" | "docx" | "md" | "txt" | "web"; status: string }[];
      libraryTitle: string;
      readerTitle: string;
      toolbar: string[];
      question: string;
      answer: string;
      cites: string[];
      noteTitle: string;
      note: string;
      tags: string[];
      pageBadge: string;
      saved: string;
      continueLabel: string;
      continueTitle: string;
      continueMeta: string;
      openQuestions: string;
      openQuestion: string;
      reviewTitle: string;
      reviewDays: string[];
      devices: string;
    };
  };
  demo: {
    eyebrow: string;
    title: string;
    lead: string;
    docTitle: string;
    docMeta: string;
    paragraphs: DocParagraph[];
    panelTitle: string;
    scope: string;
    pick: string;
    questions: DemoQuestion[];
    thinking: string;
    sources: string;
    paragraphLabel: string;
    replay: string;
    disclaimer: string;
  };
  features: {
    eyebrow: string;
    title: string;
    lead: string;
    items: Record<
      "import" | "region" | "cite" | "organize" | "relations" | "review" | "search" | "cloud",
      { title: string; body: string }
    >;
    art: {
      regionActions: string[];
      citeQuote: string;
      organizeSteps: string[];
      reviewAxis: [string, string];
      searchQuery: string;
      searchResults: string[];
      cloudStates: string[];
      relations: string[];
    };
  };
  principles: {
    eyebrow: string;
    title: string;
    marquee: string[];
    items: { title: string; body: string }[];
  };
  platforms: {
    eyebrow: string;
    title: string;
    lead: string;
    items: { name: string; detail: string; status: PlatformStatus; statusLabel: string }[];
    note: string;
    screen: {
      greetings: [string, string, string];
      continue: string;
      recent: string;
      items: string[];
    };
  };
  faq: { eyebrow: string; title: string; items: { q: string; a: string }[] };
  cta: { title: [string, string]; lead: string; primary: string; secondary: string };
  footer: {
    tagline: string;
    groups: { title: string; links: { label: string; target: string }[] }[];
    rights: string;
    note: string;
  };
}

const zh: LandingCopy = {
  meta: {
    langName: "中文",
    switchTo: "EN",
    switchLabel: "Switch to English",
    skip: "跳到主要内容",
  },
  nav: {
    links: [
      { id: "story", label: "工作流" },
      { id: "demo", label: "体验" },
      { id: "features", label: "功能" },
      { id: "platforms", label: "多端" },
      { id: "faq", label: "常见问题" },
    ],
    login: "登录",
    start: "开始使用",
    menu: "打开菜单",
    closeMenu: "关闭菜单",
    home: "Conuo 首页",
  },
  hero: {
    badge: "以个人资料库为基础的 AI 陪伴学习工作台",
    titleLines: ["陪你把", "知识学会。"],
    highlight: "学会",
    lead: "Conuo 把文件、网页和笔记组织成可检索、可追溯的个人知识库。阅读时提问，回到原文核对依据，保存自己的理解，下次从上次的问题继续。",
    primary: "开始使用",
    secondary: "看它如何工作",
    flow: ["收集资料", "阅读提问", "核对原文", "保存理解", "继续学习"],
    scroll: "向下滚动",
    bridgeEyebrow: "Knowledge, connected",
    bridge: ["把散落的资料，", "连成一张属于你的知识网。"],
  },
  story: {
    eyebrow: "学习闭环",
    title: "从一堆资料，到真正学会",
    steps: [
      {
        title: "收集资料",
        body: "PDF、DOCX、Markdown、TXT 与公开网页，统一放进学习空间。原件与版本完整保留，随时回到最初的样子。",
        points: ["多格式导入", "原件与版本保留", "标签、筛选与回收站"],
      },
      {
        title: "阅读提问",
        body: "在原文旁直接提问：选中一段文字、框选一块图表，或就整份资料发问。不必再把内容复制到别的 AI 工具里。",
        points: ["选段提问", "区域视觉学习", "Markdown 与公式"],
      },
      {
        title: "核对原文",
        body: "每个回答都带着出处。点一下引用就能跳回对应的页码与段落；资料里找不到依据时，它会明确告诉你。",
        points: ["引用可回跳", "版本可追溯", "依据不足时明确说明"],
      },
      {
        title: "保存理解",
        body: "把解释和你自己的理解整理成笔记与知识页。AI 草稿经你审核才保存，来源与历史一并保留。",
        points: ["富文本笔记与摘录", "知识页人工审核", "概念关联建议"],
      },
      {
        title: "继续学习",
        body: "换一台设备，从上次的位置和没解决的问题继续。练习与回顾帮你留下理解的证据，而不只是阅读次数。",
        points: ["云端阅读位置", "未解决问题", "练习与间隔回顾"],
      },
    ],
    stage: {
      window: "机器学习入门 · 学习空间",
      files: [
        { name: "机器学习入门.pdf", kind: "pdf", status: "可提问" },
        { name: "课程大纲.docx", kind: "docx", status: "已解析" },
        { name: "第三章笔记.md", kind: "md", status: "已解析" },
        { name: "术语表.txt", kind: "txt", status: "已解析" },
        { name: "梯度下降 · 网页快照", kind: "web", status: "可提问" },
      ],
      libraryTitle: "资料书架",
      readerTitle: "第 3 章 · 梯度下降",
      toolbar: ["提问", "批注", "摘录"],
      question: "这里为什么要沿负梯度方向更新？",
      answer: "梯度指向损失增长最快的方向，所以沿它的反方向更新，损失会在局部下降。",
      cites: ["第 12 页 ¶2", "第 12 页 ¶3"],
      noteTitle: "我的理解",
      note: "负梯度 = 局部下降最快的方向；学习率决定每一步走多远，太大会震荡。",
      tags: ["梯度下降", "学习率"],
      pageBadge: "知识页 · 待审核",
      saved: "已保存 · 云端已确认",
      continueLabel: "继续学习",
      continueTitle: "机器学习入门.pdf",
      continueMeta: "上次读到第 12 页 · 2 个未解决问题",
      openQuestions: "未解决的问题",
      openQuestion: "不同学习率如何影响收敛？",
      reviewTitle: "回顾安排",
      reviewDays: ["今天", "3 天后", "1 周后", "3 周后"],
      devices: "电脑 → iPad → 手机",
    },
  },
  demo: {
    eyebrow: "动手试试",
    title: "问一个问题，看它如何回答",
    lead: "下面是一段示例资料。选一个问题，看回答如何引用原文；也看看资料里没有依据时，它会怎么说。",
    docTitle: "机器学习入门 · 第 3 章 梯度下降",
    docMeta: "PDF · 第 12 页",
    paragraphs: [
      {
        id: 1,
        text: "梯度下降是一种迭代优化方法：从一个初始参数出发，每一步都朝着让损失函数下降最快的方向移动一小段距离。",
      },
      {
        id: 2,
        text: "对于可微的损失函数 J(θ)，梯度 ∇J(θ) 指向函数值增长最快的方向。因此，沿梯度的反方向更新参数，就能在局部让损失减小。",
      },
      {
        id: 3,
        text: "每一步的更新规则可以写成：",
        tex: "\\theta \\leftarrow \\theta - \\eta\\,\\nabla_{\\theta} J(\\theta)",
        after: "其中 η 称为学习率，决定每一步迈出的距离。",
      },
      {
        id: 4,
        text: "学习率的选择至关重要：η 过大时，参数可能在最优点附近来回震荡，甚至发散；η 过小时，更新虽然稳定，收敛却会非常缓慢。",
      },
      {
        id: 5,
        text: "实践中常用小批量梯度下降：每次只用一部分样本估计梯度，在计算成本与估计噪声之间取得平衡。",
      },
    ],
    panelTitle: "基于资料问答",
    scope: "范围：当前资料",
    pick: "选择一个示例问题",
    questions: [
      {
        id: "direction",
        label: "为什么要沿负梯度方向更新？",
        answer: [
          {
            kind: "p",
            text: "因为梯度指向损失函数**增长最快**的方向，它的反方向就是局部**下降最快**的方向 {2}。",
          },
          {
            kind: "math",
            tex: "\\theta \\leftarrow \\theta - \\eta\\,\\nabla_{\\theta} J(\\theta)",
          },
          {
            kind: "p",
            text: "资料中的更新规则正是如此：用当前参数减去学习率 η 与梯度的乘积 {3}。每一步只移动一小段距离，让损失逐步减小 {1}。",
          },
        ],
      },
      {
        id: "rate",
        label: "学习率太大或太小会怎样？",
        answer: [
          { kind: "p", text: "资料对两种情况都有说明 {4}：" },
          {
            kind: "list",
            items: [
              "**过大**：参数可能在最优点附近来回震荡，甚至发散；",
              "**过小**：更新稳定，但收敛会非常缓慢。",
            ],
          },
          {
            kind: "p",
            text: "学习率 η 决定每一步迈出的距离 {3}，因此需要在速度与稳定性之间权衡。",
          },
        ],
      },
      {
        id: "adam",
        label: "Adam 优化器是怎么工作的？",
        answer: [
          { kind: "notice", text: "当前资料范围内没有找到关于 Adam 优化器的依据。" },
          {
            kind: "p",
            text: "这一节只讨论了基础梯度下降和小批量梯度下降 {5}。你可以补充相关资料，或扩大提问范围后再问。",
          },
        ],
      },
    ],
    thinking: "正在检索资料…",
    sources: "引用来源",
    paragraphLabel: "第 12 页 · ¶",
    replay: "重新播放",
    disclaimer: "示例资料与回答仅用于演示交互效果。",
  },
  features: {
    eyebrow: "功能",
    title: "每一处细节，都为认真学习而设计",
    lead: "从导入到回顾，Conuo 把学习中真正费力的环节做扎实：资料有出处，回答可核对，理解能留下来。",
    items: {
      import: {
        title: "多格式导入",
        body: "PDF、DOCX、Markdown、TXT 与公开网页。保留原件与版本，支持备份恢复与完整导出。",
      },
      region: {
        title: "区域视觉学习",
        body: "在 PDF 上框选图表或公式，确认发送后即可解读、提问或生成一次性练习，不依赖 OCR。",
      },
      cite: {
        title: "引用回跳",
        body: "回答里的每处引用都能跳回原文的页码与段落，旧版本资料同样可以追溯。",
      },
      organize: {
        title: "知识整理",
        body: "摘要、标签、主题草稿与知识页更新。AI 生成的内容经你审核后保存，不会替代原始资料。",
      },
      relations: {
        title: "概念关联",
        body: "发现资料之间的联系与分歧，以建议的形式呈现，由你决定是否采纳。",
      },
      review: {
        title: "练习与回顾",
        body: "基于资料生成练习，先给提示、再揭晓答案；按遗忘规律安排回顾。",
      },
      search: {
        title: "统一搜索",
        body: "在资料、笔记与知识页之间检索，结果直接带你回到原文位置。",
      },
      cloud: {
        title: "云端保存与冲突保护",
        body: "“已保存”以云端确认为准。多设备编辑发生冲突时保留双方版本，由你选择或合并。",
      },
    },
    art: {
      regionActions: ["解读", "提问", "练习"],
      citeQuote: "沿梯度的反方向更新参数，就能在局部让损失减小。",
      organizeSteps: ["AI 草稿", "你来审核", "保存知识页"],
      reviewAxis: ["记忆保持", "时间"],
      searchQuery: "学习率",
      searchResults: ["机器学习入门.pdf · 第 12 页", "第三章笔记.md", "知识页 · 梯度下降"],
      cloudStates: ["保存中", "云端已确认"],
      relations: ["梯度下降", "学习率", "损失函数", "收敛", "小批量"],
    },
  },
  principles: {
    eyebrow: "我们的原则",
    title: "AI 负责陪伴，判断留给你",
    marquee: ["有出处", "可核对", "可编辑", "可导出", "可接续"],
    items: [
      {
        title: "证据优先",
        body: "原始资料、你的笔记与 AI 知识页是不同类型的证据，回答中清楚区分。",
      },
      {
        title: "由你确认",
        body: "AI 的整理结果只是草稿，经你审核才会保存，并保留来源和历史版本。",
      },
      {
        title: "授权后才用 AI",
        body: "AI 功能需要你先授权，只处理你明确选择的资料范围或截图区域。",
      },
      {
        title: "资料随时带走",
        body: "原文件、网页快照、Markdown 笔记与对话记录都能完整导出。",
      },
    ],
  },
  platforms: {
    eyebrow: "多端",
    title: "一个账号，在任何设备上接续",
    lead: "今天在电脑上读到第 12 页，明天在平板上从同一个问题继续。",
    items: [
      { name: "Web", detail: "任意设备的浏览器", status: "available", statusLabel: "现已可用" },
      { name: "Windows · macOS", detail: "桌面客户端", status: "dev", statusLabel: "开发中" },
      {
        name: "iPhone · iPad",
        detail: "原生应用，平板自适应",
        status: "dev",
        statusLabel: "开发中",
      },
      { name: "Android", detail: "长期规划", status: "planned", statusLabel: "规划中" },
    ],
    note: "客户端发布时间以实际上架为准。",
    screen: {
      greetings: ["早上好", "下午好", "晚上好"],
      continue: "继续学习",
      recent: "最近资料",
      items: ["机器学习入门.pdf", "课程大纲.docx", "第三章笔记.md"],
    },
  },
  faq: {
    eyebrow: "常见问题",
    title: "你可能想知道",
    items: [
      {
        q: "Conuo 和直接用 AI 聊天有什么不同？",
        a: "Conuo 以你自己的资料为基础。回答附带可回跳的原文引用，资料里找不到依据时会明确说明；你的问题、笔记和阅读位置都会保存下来，下次可以接着学。",
      },
      {
        q: "支持哪些资料？",
        a: "目前支持 PDF、DOCX、Markdown、TXT 和公开网页。导入后保留原件与版本，PDF 支持单页与连续滚动阅读、批注和区域视觉学习。",
      },
      {
        q: "AI 什么时候会读取我的资料？",
        a: "只有在你授权使用 AI、并明确选择提问范围后，相关内容才会交给模型处理。区域视觉学习只发送你框选并确认的截图。",
      },
      {
        q: "我的资料保存在哪里？",
        a: "Web 版的资料、笔记与学习记录统一保存在云端私有存储中。界面上的“已保存”以云端确认为准；断网时不会悄悄创建本地副本。",
      },
      {
        q: "可以导出吗？",
        a: "可以。完整导出包含原文件、网页快照、笔记与知识页的 Markdown、对话与批注 JSON，以及来源映射清单。",
      },
      {
        q: "有桌面端和手机 App 吗？",
        a: "Windows、macOS 与 iPhone、iPad 客户端正在开发中，Android 在长期规划里。现在可以在任何设备的浏览器中使用 Web 版。",
      },
    ],
  },
  cta: {
    title: ["今天读懂的，", "明天还在。"],
    lead: "创建你的第一个学习空间，从一份资料开始。",
    primary: "开始使用",
    secondary: "已有账号？登录",
  },
  footer: {
    tagline: "陪你把知识学会。",
    groups: [
      {
        title: "产品",
        links: [
          { label: "工作流", target: "story" },
          { label: "体验", target: "demo" },
          { label: "功能", target: "features" },
        ],
      },
      {
        title: "了解",
        links: [
          { label: "我们的原则", target: "principles" },
          { label: "多端", target: "platforms" },
          { label: "常见问题", target: "faq" },
        ],
      },
      {
        title: "账号",
        links: [
          { label: "登录", target: "auth:login" },
          { label: "创建账号", target: "auth:signup" },
        ],
      },
    ],
    rights: "© 2026 Conuo（可诺）",
    note: "页面中的界面与资料均为示例。",
  },
};

const en: LandingCopy = {
  meta: { langName: "English", switchTo: "中", switchLabel: "切换到中文", skip: "Skip to content" },
  nav: {
    links: [
      { id: "story", label: "Workflow" },
      { id: "demo", label: "Try it" },
      { id: "features", label: "Features" },
      { id: "platforms", label: "Platforms" },
      { id: "faq", label: "FAQ" },
    ],
    login: "Log in",
    start: "Get started",
    menu: "Open menu",
    closeMenu: "Close menu",
    home: "Conuo home",
  },
  hero: {
    badge: "An AI study companion built on your own library",
    titleLines: ["From reading", "to really knowing."],
    highlight: "really knowing.",
    lead: "Conuo turns your files, web pages and notes into a searchable, traceable personal knowledge base. Ask while you read, check every answer against the source, keep what you understood, and pick up exactly where you left off.",
    primary: "Get started",
    secondary: "See how it works",
    flow: ["Collect", "Read & ask", "Verify", "Keep", "Continue"],
    scroll: "Scroll",
    bridgeEyebrow: "Knowledge, connected",
    bridge: ["Scattered materials,", "woven into a web of your own."],
  },
  story: {
    eyebrow: "The learning loop",
    title: "From a pile of files to real understanding",
    steps: [
      {
        title: "Collect",
        body: "PDF, DOCX, Markdown, TXT and public web pages live together in one study space. Originals and versions are kept, so you can always go back to the source.",
        points: ["Multi-format import", "Originals & versions kept", "Tags, filters & trash"],
      },
      {
        title: "Read & ask",
        body: "Ask right next to the text: select a passage, draw a box around a figure, or question the whole document. No more copy-pasting into another AI tool.",
        points: ["Ask about a selection", "Visual region study", "Markdown & math"],
      },
      {
        title: "Verify",
        body: "Every answer comes with its sources. One click takes you back to the exact page and paragraph, and when the material has no evidence, it tells you so.",
        points: ["Jump-back citations", "Traceable versions", "Honest about missing evidence"],
      },
      {
        title: "Keep",
        body: "Turn explanations and your own understanding into notes and knowledge pages. AI drafts are only saved after you review them, with sources and history intact.",
        points: ["Rich notes & excerpts", "Human-reviewed pages", "Concept link suggestions"],
      },
      {
        title: "Continue",
        body: "Switch devices and resume from the same page and the same open questions. Practice and review leave evidence of understanding, not just a read count.",
        points: ["Cloud reading position", "Open questions", "Practice & spaced review"],
      },
    ],
    stage: {
      window: "Intro to Machine Learning · Study space",
      files: [
        { name: "intro-to-ml.pdf", kind: "pdf", status: "Ready to ask" },
        { name: "syllabus.docx", kind: "docx", status: "Parsed" },
        { name: "chapter-3-notes.md", kind: "md", status: "Parsed" },
        { name: "glossary.txt", kind: "txt", status: "Parsed" },
        { name: "Gradient descent · web snapshot", kind: "web", status: "Ready to ask" },
      ],
      libraryTitle: "Library",
      readerTitle: "Chapter 3 · Gradient descent",
      toolbar: ["Ask", "Annotate", "Excerpt"],
      question: "Why do we step along the negative gradient?",
      answer:
        "The gradient points where the loss grows fastest, so moving the opposite way lowers the loss locally.",
      cites: ["p.12 ¶2", "p.12 ¶3"],
      noteTitle: "My understanding",
      note: "Negative gradient = locally steepest descent. The learning rate sets the step size; too large and it oscillates.",
      tags: ["Gradient descent", "Learning rate"],
      pageBadge: "Knowledge page · in review",
      saved: "Saved · confirmed in cloud",
      continueLabel: "Continue",
      continueTitle: "intro-to-ml.pdf",
      continueMeta: "Last read on page 12 · 2 open questions",
      openQuestions: "Open questions",
      openQuestion: "How do different learning rates affect convergence?",
      reviewTitle: "Review schedule",
      reviewDays: ["Today", "In 3 days", "In 1 week", "In 3 weeks"],
      devices: "Laptop → iPad → Phone",
    },
  },
  demo: {
    eyebrow: "Try it",
    title: "Ask a question. Watch it answer.",
    lead: "Below is a sample reading. Pick a question to see how answers cite the source, and what happens when the material simply doesn't cover it.",
    docTitle: "Intro to Machine Learning · Ch. 3 Gradient descent",
    docMeta: "PDF · page 12",
    paragraphs: [
      {
        id: 1,
        text: "Gradient descent is an iterative optimisation method: starting from initial parameters, each step moves a small distance in the direction that decreases the loss the fastest.",
      },
      {
        id: 2,
        text: "For a differentiable loss J(θ), the gradient ∇J(θ) points in the direction of steepest increase. Updating the parameters against the gradient therefore reduces the loss locally.",
      },
      {
        id: 3,
        text: "Each step can be written as:",
        tex: "\\theta \\leftarrow \\theta - \\eta\\,\\nabla_{\\theta} J(\\theta)",
        after: "where η is the learning rate, which sets how far each step goes.",
      },
      {
        id: 4,
        text: "Choosing the learning rate matters: if η is too large, the parameters may oscillate around the optimum or even diverge; if it is too small, updates are stable but convergence is painfully slow.",
      },
      {
        id: 5,
        text: "In practice, mini-batch gradient descent is common: each step estimates the gradient from a subset of samples, balancing compute cost against estimation noise.",
      },
    ],
    panelTitle: "Ask your material",
    scope: "Scope: this document",
    pick: "Pick a sample question",
    questions: [
      {
        id: "direction",
        label: "Why step along the negative gradient?",
        answer: [
          {
            kind: "p",
            text: "Because the gradient points where the loss **increases fastest**, its opposite is the direction of **steepest local decrease** {2}.",
          },
          {
            kind: "math",
            tex: "\\theta \\leftarrow \\theta - \\eta\\,\\nabla_{\\theta} J(\\theta)",
          },
          {
            kind: "p",
            text: "That is exactly the update rule in the text: subtract the learning rate η times the gradient from the current parameters {3}. Each small step lowers the loss a little further {1}.",
          },
        ],
      },
      {
        id: "rate",
        label: "What if the learning rate is too big or too small?",
        answer: [
          { kind: "p", text: "The text covers both cases {4}:" },
          {
            kind: "list",
            items: [
              "**Too large**: the parameters may oscillate around the optimum or even diverge;",
              "**Too small**: updates are stable, but convergence is very slow.",
            ],
          },
          {
            kind: "p",
            text: "Since η sets the size of every step {3}, it is a trade-off between speed and stability.",
          },
        ],
      },
      {
        id: "adam",
        label: "How does the Adam optimiser work?",
        answer: [
          {
            kind: "notice",
            text: "No evidence about the Adam optimiser was found in the current scope.",
          },
          {
            kind: "p",
            text: "This section only covers plain and mini-batch gradient descent {5}. Add material that covers Adam, or widen the scope, and ask again.",
          },
        ],
      },
    ],
    thinking: "Searching your material…",
    sources: "Sources",
    paragraphLabel: "p.12 · ¶",
    replay: "Replay",
    disclaimer: "Sample material and answers, for demonstration only.",
  },
  features: {
    eyebrow: "Features",
    title: "Every detail, designed for serious learning",
    lead: "From import to review, Conuo gets the hard parts of studying right: sources stay attached, answers can be checked, and understanding sticks around.",
    items: {
      import: {
        title: "Multi-format import",
        body: "PDF, DOCX, Markdown, TXT and public web pages. Originals and versions are kept, with backup, restore and full export.",
      },
      region: {
        title: "Visual region study",
        body: "Box a figure or formula in a PDF, confirm, and get an explanation, answers or a one-off exercise. No OCR required.",
      },
      cite: {
        title: "Jump-back citations",
        body: "Every citation in an answer opens the exact page and paragraph, even for earlier versions of a file.",
      },
      organize: {
        title: "Knowledge organisation",
        body: "Summaries, tags, topic drafts and page updates. AI output is saved only after your review and never replaces the source.",
      },
      relations: {
        title: "Concept links",
        body: "Surface connections and disagreements across materials as suggestions you choose to accept.",
      },
      review: {
        title: "Practice & review",
        body: "Exercises generated from your material, hints before answers, and reviews scheduled around forgetting.",
      },
      search: {
        title: "Unified search",
        body: "Search across sources, notes and knowledge pages, and land right back at the original passage.",
      },
      cloud: {
        title: "Cloud saves, conflict-safe",
        body: "“Saved” means confirmed by the cloud. When devices conflict, both versions are kept for you to pick or merge.",
      },
    },
    art: {
      regionActions: ["Explain", "Ask", "Practice"],
      citeQuote: "Updating the parameters against the gradient reduces the loss locally.",
      organizeSteps: ["AI draft", "You review", "Saved page"],
      reviewAxis: ["Retention", "Time"],
      searchQuery: "learning rate",
      searchResults: ["intro-to-ml.pdf · p.12", "chapter-3-notes.md", "Page · Gradient descent"],
      cloudStates: ["Saving", "Confirmed in cloud"],
      relations: ["Gradient", "Learning rate", "Loss", "Convergence", "Mini-batch"],
    },
  },
  principles: {
    eyebrow: "Principles",
    title: "AI keeps you company. You keep the judgement.",
    marquee: ["Sourced", "Verifiable", "Editable", "Exportable", "Resumable"],
    items: [
      {
        title: "Evidence first",
        body: "Original sources, your notes and AI pages are different kinds of evidence, and answers keep them apart.",
      },
      {
        title: "You confirm",
        body: "AI organisation is a draft until you review it, and it keeps its sources and version history.",
      },
      {
        title: "AI only with consent",
        body: "AI features need your permission first and only see the scope or screenshot you explicitly choose.",
      },
      {
        title: "Take it with you",
        body: "Original files, web snapshots, Markdown notes and conversations can all be exported in full.",
      },
    ],
  },
  platforms: {
    eyebrow: "Platforms",
    title: "One account. Pick up on any device.",
    lead: "Read to page 12 on your laptop today, continue from the same question on your tablet tomorrow.",
    items: [
      { name: "Web", detail: "Any modern browser", status: "available", statusLabel: "Available" },
      {
        name: "Windows · macOS",
        detail: "Desktop app",
        status: "dev",
        statusLabel: "In development",
      },
      {
        name: "iPhone · iPad",
        detail: "Native, tablet-adaptive",
        status: "dev",
        statusLabel: "In development",
      },
      { name: "Android", detail: "Long-term plan", status: "planned", statusLabel: "Planned" },
    ],
    note: "Native app availability depends on actual store release.",
    screen: {
      greetings: ["Good morning", "Good afternoon", "Good evening"],
      continue: "Continue",
      recent: "Recent",
      items: ["intro-to-ml.pdf", "syllabus.docx", "chapter-3-notes.md"],
    },
  },
  faq: {
    eyebrow: "FAQ",
    title: "Good questions",
    items: [
      {
        q: "How is this different from chatting with an AI?",
        a: "Conuo works from your own material. Answers carry citations you can jump back to, and it says so when the material has no evidence. Your questions, notes and reading position are kept, so the next session starts where this one ended.",
      },
      {
        q: "What can I import?",
        a: "PDF, DOCX, Markdown, TXT and public web pages. Originals and versions are kept; PDFs support single-page and continuous reading, annotations and visual region study.",
      },
      {
        q: "When does AI read my material?",
        a: "Only after you enable AI and explicitly choose what to ask about. Visual region study sends only the screenshot you boxed and confirmed.",
      },
      {
        q: "Where is my data stored?",
        a: "On the web, sources, notes and learning history live in private cloud storage. “Saved” in the interface means the cloud confirmed it; going offline never silently creates a local copy.",
      },
      {
        q: "Can I export everything?",
        a: "Yes. A full export includes original files, web snapshots, notes and knowledge pages as Markdown, conversations and annotations as JSON, and a source mapping manifest.",
      },
      {
        q: "Are there desktop and mobile apps?",
        a: "Windows, macOS, iPhone and iPad apps are in development, and Android is on the long-term roadmap. Today you can use the web app in any browser.",
      },
    ],
  },
  cta: {
    title: ["What you understand today", "is still yours tomorrow."],
    lead: "Create your first study space and start with a single document.",
    primary: "Get started",
    secondary: "Have an account? Log in",
  },
  footer: {
    tagline: "Learn it, for real.",
    groups: [
      {
        title: "Product",
        links: [
          { label: "Workflow", target: "story" },
          { label: "Try it", target: "demo" },
          { label: "Features", target: "features" },
        ],
      },
      {
        title: "Learn more",
        links: [
          { label: "Principles", target: "principles" },
          { label: "Platforms", target: "platforms" },
          { label: "FAQ", target: "faq" },
        ],
      },
      {
        title: "Account",
        links: [
          { label: "Log in", target: "auth:login" },
          { label: "Create account", target: "auth:signup" },
        ],
      },
    ],
    rights: "© 2026 Conuo",
    note: "Interfaces and materials shown are illustrative.",
  },
};

export const landingCopy: Record<Lang, LandingCopy> = { zh, en };

export function initialLang(): Lang {
  try {
    const stored = window.localStorage.getItem(LANG_STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // Storage can be unavailable (private mode, blocked site data); fall through.
  }
  if (typeof navigator !== "undefined" && navigator.language && !/^zh\b/i.test(navigator.language))
    return "en";
  return "zh";
}

export const LANG_STORAGE_KEY = "conuo.landing.lang";
