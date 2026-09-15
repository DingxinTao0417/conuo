import { chunkText, makeWebSource } from "./import";
import type { Source, WorkspaceData } from "./types";

export function createEmptyWorkspace(): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [
      {
        id: crypto.randomUUID(),
        name: "我的学习空间",
        goal: "",
        color: "#4B3FE3",
        archived: false,
        createdAt: new Date().toISOString(),
      },
    ],
    sources: [],
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
    importJobs: [],
  };
}

/** Optional original sample. Never mixed into a new user's empty workspace. */
export function createDemoWorkspace(): WorkspaceData {
  const data = createEmptyWorkspace();
  const space = data.spaces[0];
  space.name = "机器学习入门 · 示例";
  space.goal = "理解梯度下降，用自己的话说明学习率的作用。";
  const now = new Date().toISOString();
  const source: Source = {
    id: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    title: "梯度下降与学习率 · 示例资料",
    filename: "梯度下降与学习率-示例.md",
    kind: "markdown",
    mime: "text/markdown",
    size: 0,
    hash: "",
    spaceIds: [space.id],
    tags: ["机器学习", "优化方法", "示例"],
    status: "ready",
    chunks: [],
    text: `# 梯度下降与学习率\n\n这是一份 Conuo 自编的示例资料，用于体验阅读、原文证据检索和笔记，不对应外部教材。\n\n## 梯度下降在做什么\n\n训练模型时，我们用损失函数衡量预测与目标之间的差距。梯度表示当前位置损失上升最快的方向；沿梯度的反方向移动参数，通常可以在足够小的一步内降低损失。反复计算梯度、更新参数，就是梯度下降。\n\n## 学习率决定每一步走多远\n\n学习率是更新参数时的步长系数。参数更新可以写为：新参数 = 旧参数 − 学习率 × 梯度。学习率太小，损失下降缓慢，需要更多次更新；学习率太大，参数可能反复越过较好的位置，损失出现振荡，甚至持续增大。\n\n## 怎样判断学习率是否过高\n\n观察连续多次更新的训练损失。如果训练损失反复出现很大的波动，或持续增大，可以把学习率降低到原来的十分之一，保持其他设置不变，再比较训练曲线。若曲线明显稳定，说明原学习率可能过高。这只是一个诊断线索，也需要检查数据、损失实现和梯度是否异常。\n\n## 一个可以自己试的例子\n\n对函数 L(w) = w²，梯度为 2w。从 w = 4 开始，学习率设为 0.1，则下一步 w = 4 − 0.1 × 8 = 3.2，损失从 16 降为 10.24。这个一维例子用于理解更新规则，不能直接给出所有神经网络的最佳学习率。`,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: true,
  };
  source.size = new TextEncoder().encode(source.text).byteLength;
  source.chunks = chunkText(source.text, source.id, source.versionId);
  data.sources.push(source);
  const practice = makeWebSource({
    url: "https://example.com/conuo-demo",
    title: "用自我解释检查理解 · 示例资料",
    spaceId: space.id,
    aiAllowed: true,
    text: "# 用自我解释检查理解\n\n这是 Conuo 自编的示例练习，链接仅为示例地址，内容没有从该网站抓取。\n\n## 合上资料再解释\n\n读完一个概念后，暂时合上资料，用自己的话回答三个问题：它解决什么问题？关键步骤是什么？在什么条件下可能失效？如果只能重复原文的术语而说不出因果关系，应返回对应段落继续阅读。\n\n## 对学习率的自我解释\n\n请解释为什么学习率太大可能让训练损失振荡，并用一个一维函数的更新步骤验证。把自己的解释和资料中的原文对照，记录还不能说明白的问题。",
  });
  practice.tags = ["学习方法", "示例"];
  data.sources.push(practice);
  return data;
}
