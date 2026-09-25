"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "katex/dist/katex.min.css";
import { BookOpen, FileText, RotateCcw, SearchX, Sparkles, User } from "lucide-react";
import type { Lang, LandingCopy } from "./copy";
import { answerCitations, blockLength, plainAnswer, revealedRefs, tokenizeInline } from "./text";
import { SectionHeading } from "./ui";

type Phase = "idle" | "thinking" | "streaming" | "done";

/** KaTeX is loaded on demand so the homepage bundle stays lean. */
function Tex({ tex }: { tex: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    import("katex")
      .then(({ default: katex }) => {
        if (active)
          setHtml(
            katex.renderToString(tex, { displayMode: true, throwOnError: false, output: "html" }),
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [tex]);
  // KaTeX output of a static, first-party formula.
  return html ? (
    <div className="lp-tex" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <div className="lp-tex is-loading" aria-hidden="true" />
  );
}

export default function AskDemo({
  t,
  lang,
  reduced,
}: {
  t: LandingCopy["demo"];
  lang: Lang;
  reduced: boolean;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [shown, setShown] = useState(0);
  const [focusRef, setFocusRef] = useState<number | null>(null);

  const question = t.questions.find((item) => item.id === questionId) ?? null;
  const total = useMemo(
    () => (question ? question.answer.reduce((sum, block) => sum + blockLength(block), 0) : 0),
    [question],
  );
  const budget = phase === "done" ? Number.POSITIVE_INFINITY : phase === "streaming" ? shown : 0;
  const visibleRefs = useMemo(
    () => (question ? revealedRefs(question.answer, budget) : new Set<number>()),
    [question, budget],
  );

  const ask = useCallback(
    (id: string) => {
      setQuestionId(id);
      setShown(0);
      setFocusRef(null);
      setPhase(reduced ? "done" : "thinking");
    },
    [reduced],
  );

  // Autoplay the first question the first time the demo scrolls into view.
  // (The landing remounts this component per language, so it replays on switch.)
  const firstQuestion = t.questions[0].id;
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    if (typeof IntersectionObserver === "undefined") {
      queueMicrotask(() => ask(firstQuestion));
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        ask(firstQuestion);
      },
      { rootMargin: "0px 0px -35% 0px" },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, [ask, firstQuestion]);

  useEffect(() => {
    if (phase !== "thinking") return;
    const timer = window.setTimeout(() => setPhase("streaming"), 780);
    return () => window.clearTimeout(timer);
  }, [phase, questionId]);

  useEffect(() => {
    if (phase !== "streaming") return;
    const perSecond = lang === "zh" ? 36 : 90;
    const started = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const next = Math.floor(((now - started) / 1000) * perSecond);
      if (next >= total) {
        setShown(total);
        setPhase("done");
        return;
      }
      setShown(next);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [phase, total, lang, questionId]);

  const renderInline = (text: string, state: { left: number }): ReactNode[] =>
    tokenizeInline(text).map((token, index) => {
      if (state.left <= 0) return null;
      if (token.kind === "cite") {
        state.left -= 1;
        return (
          <button
            type="button"
            key={index}
            className={`lp-cite ${focusRef === token.ref ? "is-focus" : ""}`}
            onMouseEnter={() => setFocusRef(token.ref)}
            onMouseLeave={() => setFocusRef(null)}
            onFocus={() => setFocusRef(token.ref)}
            onBlur={() => setFocusRef(null)}
            aria-label={`${t.paragraphLabel}${token.ref}`}
          >
            ¶{token.ref}
          </button>
        );
      }
      const chars = Array.from(token.value);
      const visible = chars.slice(0, state.left).join("");
      state.left -= chars.length;
      return token.bold ? (
        <strong key={index}>{visible}</strong>
      ) : (
        <Fragment key={index}>{visible}</Fragment>
      );
    });

  const renderAnswer = () => {
    if (!question) return null;
    const state = { left: budget };
    const nodes: ReactNode[] = [];
    question.answer.forEach((block, index) => {
      if (state.left <= 0) return;
      if (block.kind === "math") {
        state.left -= 1;
        nodes.push(<Tex key={index} tex={block.tex} />);
      } else if (block.kind === "list") {
        nodes.push(
          <ul key={index}>
            {block.items.map((item, itemIndex) =>
              state.left > 0 ? <li key={itemIndex}>{renderInline(item, state)}</li> : null,
            )}
          </ul>,
        );
      } else if (block.kind === "notice") {
        nodes.push(
          <p key={index} className="lp-answer-notice">
            <SearchX size={15} aria-hidden="true" />
            <span>{renderInline(block.text, state)}</span>
          </p>,
        );
      } else nodes.push(<p key={index}>{renderInline(block.text, state)}</p>);
    });
    return nodes;
  };

  const citations = question ? answerCitations(question.answer) : [];

  return (
    <section
      id="demo"
      className="lp-demo"
      data-tone="light"
      ref={sectionRef}
      aria-labelledby="lp-demo-title"
    >
      <div className="lp-container">
        <SectionHeading eyebrow={t.eyebrow} title={t.title} lead={t.lead} id="lp-demo-title" />
        <div className="lp-demo-grid">
          <article className="lp-doc" aria-label={t.docTitle}>
            <header className="lp-doc-head">
              <span className="lp-doc-icon">
                <FileText size={16} aria-hidden="true" />
              </span>
              <div>
                <strong>{t.docTitle}</strong>
                <span>{t.docMeta}</span>
              </div>
            </header>
            <div className="lp-doc-body">
              {t.paragraphs.map((paragraph) => (
                <div
                  key={paragraph.id}
                  className={`lp-doc-para ${visibleRefs.has(paragraph.id) ? "is-cited" : ""} ${
                    focusRef === paragraph.id ? "is-focus" : ""
                  }`}
                >
                  <span className="lp-doc-mark lp-mono" aria-hidden="true">
                    ¶{paragraph.id}
                  </span>
                  <div>
                    <p>{paragraph.text}</p>
                    {paragraph.tex ? <Tex tex={paragraph.tex} /> : null}
                    {paragraph.after ? <p>{paragraph.after}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          </article>

          <div className="lp-panel">
            <header className="lp-panel-head">
              <span className="lp-panel-title">
                <Sparkles size={16} aria-hidden="true" />
                {t.panelTitle}
              </span>
              <span className="lp-scope">{t.scope}</span>
            </header>

            <div className="lp-panel-questions" role="group" aria-label={t.pick}>
              {t.questions.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={item.id === questionId}
                  onClick={() => ask(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="lp-thread" data-lenis-prevent>
              {question ? (
                <>
                  <div className="lp-bubble is-user">
                    <span className="lp-avatar" aria-hidden="true">
                      <User size={14} />
                    </span>
                    <p>{question.label}</p>
                  </div>
                  <div className="lp-bubble is-ai">
                    <span className="lp-avatar is-ai" aria-hidden="true">
                      <Sparkles size={14} />
                    </span>
                    <div className="lp-answer" aria-hidden={phase !== "done"}>
                      {phase === "thinking" ? (
                        <p className="lp-thinking">
                          <span className="lp-shimmer">{t.thinking}</span>
                        </p>
                      ) : (
                        renderAnswer()
                      )}
                      {phase === "streaming" ? (
                        <span className="lp-caret" aria-hidden="true" />
                      ) : null}
                    </div>
                  </div>
                  <p className="lp-sr" aria-live="polite">
                    {phase === "done" ? plainAnswer(question.answer, t.paragraphLabel) : ""}
                  </p>
                </>
              ) : null}
            </div>

            <footer className="lp-panel-foot">
              <div className={`lp-sources ${phase === "done" ? "is-visible" : ""}`}>
                <span>{t.sources}</span>
                {citations.map((ref) => (
                  <button
                    type="button"
                    key={ref}
                    className={`lp-source-chip ${focusRef === ref ? "is-focus" : ""}`}
                    onMouseEnter={() => setFocusRef(ref)}
                    onMouseLeave={() => setFocusRef(null)}
                    onFocus={() => setFocusRef(ref)}
                    onBlur={() => setFocusRef(null)}
                  >
                    <BookOpen size={12} aria-hidden="true" />
                    {t.paragraphLabel}
                    {ref}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="lp-replay"
                onClick={() => questionId && ask(questionId)}
                disabled={!questionId || phase === "thinking" || phase === "streaming"}
              >
                <RotateCcw size={14} aria-hidden="true" />
                {t.replay}
              </button>
            </footer>
          </div>
        </div>
        <p className="lp-demo-note">{t.disclaimer}</p>
      </div>
    </section>
  );
}
