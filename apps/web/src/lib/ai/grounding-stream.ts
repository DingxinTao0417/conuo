import { bindGeneratedAnswer, type AnswerFormat, type Grounding } from "./grounding";
import { ApiError } from "../supabase/api";
import type { AnswerResult } from "../types";

type ObjectFrame = {
  type: "object";
  role: "root" | "paragraph";
  state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd";
  values: Record<string, unknown>;
  keys: Set<string>;
  key?: string;
};
type ArrayFrame = {
  type: "array";
  role: "paragraphs" | "evidenceIds";
  state: "valueOrEnd" | "value" | "commaOrEnd";
  values: unknown[];
};
type Frame = ObjectFrame | ArrayFrame;

const invalid = () => new ApiError(502, "INVALID_MODEL_ANSWER", "模型回答格式不完整，请重新生成。");

/**
 * Incrementally recognizes the existing grounding JSON grammar without repairing JSON.
 * Only closed, schema-validated paragraphs can become a provisional answer. Callers must
 * still validate the full raw answer, current permissions, citations, and ledger completion.
 */
export function createGroundingPreview(
  grounding: Grounding,
  options: { format?: AnswerFormat } = {},
): {
  push(delta: string): AnswerResult | undefined;
} {
  const root: ObjectFrame = {
    type: "object",
    role: "root",
    state: "keyOrEnd",
    values: {},
    keys: new Set(),
  };
  const stack: Frame[] = [];
  const paragraphs: unknown[] = [];
  let raw = "";
  let started = false;
  let complete = false;
  let inString = false;
  let escaped = false;
  let string = "";
  let emitted = 0;
  let failed = false;

  const finishValue = (value: unknown) => {
    const parent = stack.at(-1);
    if (!parent) {
      complete = true;
      return;
    }
    if (parent.type === "object") {
      if (parent.state !== "value" || !parent.key) throw invalid();
      parent.values[parent.key] = value;
      parent.state = "commaOrEnd";
      if (parent.role === "root" && parent.key === "status") {
        if (value !== "answered" && value !== "insufficient") throw invalid();
        if (value === "insufficient" && paragraphs.length) throw invalid();
      }
    } else {
      if (parent.state !== "valueOrEnd" && parent.state !== "value") throw invalid();
      parent.values.push(value);
      parent.state = "commaOrEnd";
      if (parent.values.length > (parent.role === "paragraphs" ? 10 : 12)) throw invalid();
      if (parent.role === "paragraphs") {
        // Reuse the final binder's exact paragraph schema, canonical references and escaping.
        bindGeneratedAnswer(
          JSON.stringify({ status: "answered", paragraphs: [value] }),
          grounding,
          options,
        );
        if (root.values.status === "insufficient") throw invalid();
        paragraphs.push(value);
      }
    }
  };

  const token = (value: string, isString: boolean) => {
    if (!started) {
      if (isString || value !== "{") throw invalid();
      started = true;
      stack.push(root);
      return;
    }
    const frame = stack.at(-1);
    if (!frame || complete) throw invalid();
    if (frame.type === "object") {
      if (frame.state === "keyOrEnd" || frame.state === "key") {
        if (!isString && value === "}" && frame.state === "keyOrEnd") {
          stack.pop();
          finishValue(frame.values);
          return;
        }
        const allowed =
          frame.role === "root" ? ["status", "paragraphs"] : ["text", "evidenceIds", "kind"];
        if (!isString || !allowed.includes(value) || frame.keys.has(value)) throw invalid();
        frame.keys.add(value);
        frame.key = value;
        frame.state = "colon";
        return;
      }
      if (frame.state === "colon") {
        if (isString || value !== ":") throw invalid();
        frame.state = "value";
        return;
      }
    }
    if (frame.state === "commaOrEnd") {
      if (!isString && value === ",") {
        frame.state = frame.type === "object" ? "key" : "value";
        return;
      }
      if (!isString && value === (frame.type === "object" ? "}" : "]")) {
        stack.pop();
        finishValue(frame.values);
        return;
      }
      throw invalid();
    }
    if (frame.type === "array" && frame.state === "valueOrEnd" && !isString && value === "]") {
      stack.pop();
      finishValue(frame.values);
      return;
    }

    const expectingArray =
      frame.type === "object" && (frame.key === "paragraphs" || frame.key === "evidenceIds");
    if (expectingArray) {
      if (isString || value !== "[") throw invalid();
      stack.push({
        type: "array",
        role: frame.key as ArrayFrame["role"],
        state: "valueOrEnd",
        values: [],
      });
    } else if (frame.type === "array" && frame.role === "paragraphs") {
      if (isString || value !== "{") throw invalid();
      stack.push({
        type: "object",
        role: "paragraph",
        state: "keyOrEnd",
        values: {},
        keys: new Set(),
      });
    } else {
      if (!isString) throw invalid();
      finishValue(value);
    }
  };

  return {
    push(delta) {
      if (failed) throw invalid();
      try {
        if (typeof delta !== "string" || raw.length + delta.length > 32_000) throw invalid();
        raw += delta;
        for (const char of delta) {
          if (inString) {
            string += char;
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') {
              inString = false;
              let value: unknown;
              try {
                value = JSON.parse(string);
              } catch {
                throw invalid();
              }
              if (typeof value !== "string") throw invalid();
              token(value, true);
              string = "";
            } else if (char.charCodeAt(0) < 32) throw invalid();
          } else if (char === '"') {
            inString = true;
            string = char;
          } else if (!/[ \t\r\n]/.test(char)) token(char, false);
        }
        if (complete) bindGeneratedAnswer(raw, grounding, options);
        if (root.values.status !== "answered" || paragraphs.length <= emitted) return undefined;
        const answer = bindGeneratedAnswer(
          JSON.stringify({ status: "answered", paragraphs }),
          grounding,
          options,
        );
        emitted = paragraphs.length;
        return answer;
      } catch (error) {
        failed = true;
        if (error instanceof ApiError) throw error;
        throw invalid();
      }
    },
  };
}
