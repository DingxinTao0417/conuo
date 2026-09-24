/** KaTeX may mutate `macros` for \gdef, so every render gets a fresh object. */
export function safeKatexOptions() {
  return { trust: false, maxExpand: 1000, maxSize: 10, strict: "ignore" as const, macros: {} };
}

export const answerMathOptions = { singleDollarTextMath: false } as const;
