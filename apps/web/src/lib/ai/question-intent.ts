/** Evidence-assembly intent only. It never widens or narrows a request's source scope. */
export type QuestionIntent = "summary" | "comparison" | "targeted";

// “比较”后面跟形容词时是程度副词（比较大、比较难），不是比较意图。
const COMPARISON =
  /比较(?![大小高低多少好坏快慢难易长短强弱深浅重轻常])|对比|异同|区别|差异|不同之处|有何不同|有什么不同|相同之处|\bcompare\b|comparison|difference|versus|\bvs\.?(?=\s)/iu;
const SUMMARY =
  /总结|概括|梳理|归纳|要点|大纲|提纲|脉络|核心观点|主要(?:内容|观点|结论|讲了|介绍)|全文|整篇|全书|(?:讲|写|说)了(?:些)?什么|summari[sz]e|summary|overview|outline|main (?:points|ideas)|key (?:points|takeaways)|tl;?dr/iu;

export function classifyQuestionIntent(question: string): QuestionIntent {
  const text = question.normalize("NFKC");
  if (COMPARISON.test(text)) return "comparison";
  if (SUMMARY.test(text)) return "summary";
  return "targeted";
}
