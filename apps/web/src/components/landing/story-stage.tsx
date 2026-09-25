"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import {
  BookOpen,
  Check,
  CircleHelp,
  Cloud,
  FileText,
  Highlighter,
  Laptop,
  Library,
  MessageSquareText,
  NotebookPen,
  Plus,
  Search,
  SendHorizontal,
  Smartphone,
  Sparkles,
  Tablet,
} from "lucide-react";
import type { LandingCopy } from "./copy";
import { FileGlyph, vars } from "./ui";

type Stage = LandingCopy["story"]["stage"];

/** Scales the fixed 600×460 design canvas to the available width. */
function useFit() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = () => element.style.setProperty("--s", String(element.clientWidth / 600));
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return ref;
}

/** Typewriter text: characters keep their layout and fade in one after another. */
function Typed({ text, delay, step = 0.035 }: { text: string; delay: number; step?: number }) {
  return (
    <span className="lp-typed" style={vars({ "--td": `${delay}s`, "--ts": `${step}s` })}>
      {Array.from(text).map((char, index) => (
        <i key={index} style={vars({ "--ti": index })}>
          {char}
        </i>
      ))}
    </span>
  );
}

const FLY_FROM = [
  "translate(-140px, 60px) rotate(-10deg)",
  "translate(120px, -80px) rotate(8deg)",
  "translate(-90px, -120px) rotate(-6deg)",
  "translate(150px, 70px) rotate(11deg)",
  "translate(-60px, 140px) rotate(-4deg)",
];

function Collect({ s }: { s: Stage }) {
  return (
    <>
      <div className="lp-s1-head">
        <Library size={16} />
        <strong>{s.libraryTitle}</strong>
        <span className="lp-pill">{s.files.length}</span>
        <span className="lp-s1-import">
          <Plus size={13} />
        </span>
      </div>
      <ul className="lp-s1-list">
        {s.files.map((file, index) => (
          <li
            key={file.name}
            className="lp-anim lp-s1-row"
            style={vars({ "--from": FLY_FROM[index], "--d": `${0.08 + index * 0.09}s` })}
          >
            <FileGlyph kind={file.kind} />
            <div className="lp-s1-meta">
              <span className="lp-s1-name">{file.name}</span>
              <span className="lp-s1-bar">
                <i style={vars({ "--d": `${0.55 + index * 0.12}s` })} />
              </span>
            </div>
            <span
              className={`lp-s1-status ${index === 0 || index === 4 ? "is-ready" : ""}`}
              style={vars({ "--d": `${0.8 + index * 0.1}s` })}
            >
              {file.status}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function PageLines({ count, from = 0 }: { count: number; from?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <i
          key={index}
          className="lp-line"
          style={vars({ "--w": `${[92, 86, 95, 70, 88, 64][(index + from) % 6]}%` })}
        />
      ))}
    </>
  );
}

function Read({ s, excerpt }: { s: Stage; excerpt: string }) {
  return (
    <>
      <div className="lp-s2-page">
        <div className="lp-page-head">
          <FileText size={13} />
          <span>{s.readerTitle}</span>
          <em>12 / 48</em>
        </div>
        <PageLines count={4} />
        <p className="lp-s2-text">
          <mark className="lp-anim lp-s2-mark">{excerpt}</mark>
        </p>
        <PageLines count={5} from={2} />
        <div className="lp-anim lp-s2-toolbar">
          <span>
            <MessageSquareText size={12} />
            {s.toolbar[0]}
          </span>
          <span>
            <Highlighter size={12} />
            {s.toolbar[1]}
          </span>
          <span>
            <NotebookPen size={12} />
            {s.toolbar[2]}
          </span>
        </div>
      </div>
      <div className="lp-anim lp-s2-ask">
        <div className="lp-s2-ask-head">
          <Sparkles size={13} />
          <span>{s.toolbar[0]}</span>
        </div>
        <p className="lp-s2-typed">
          <Typed text={s.question} delay={1.25} />
        </p>
        <span className="lp-s2-send">
          <SendHorizontal size={13} />
        </span>
      </div>
    </>
  );
}

function Verify({ s }: { s: Stage }) {
  return (
    <>
      <div className="lp-s3-page">
        <div className="lp-page-head">
          <FileText size={13} />
          <span>{s.readerTitle}</span>
        </div>
        <div className="lp-s3-para">
          <b>¶1</b>
          <PageLines count={2} />
        </div>
        <div className="lp-s3-para lp-anim is-cited is-a">
          <b>¶2</b>
          <PageLines count={3} from={1} />
        </div>
        <div className="lp-s3-para lp-anim is-cited is-b">
          <b>¶3</b>
          <PageLines count={2} from={3} />
          <span className="lp-s3-formula">θ ← θ − η∇J(θ)</span>
        </div>
        <div className="lp-s3-para">
          <b>¶4</b>
          <PageLines count={3} from={4} />
        </div>
      </div>
      <svg className="lp-s3-links" viewBox="0 0 544 416" aria-hidden="true">
        <path className="lp-anim is-a" d="M 300 266 C 268 266, 276 146, 246 146" />
        <path className="lp-anim is-b" d="M 300 266 C 272 266, 276 219, 246 219" />
      </svg>
      <div className="lp-anim lp-s3-answer">
        <div className="lp-s3-answer-head">
          <Sparkles size={13} />
          <span>{s.question}</span>
        </div>
        <p>{s.answer}</p>
        <div className="lp-s3-cites">
          {s.cites.map((cite, index) => (
            <span key={cite} className={`lp-cite-chip ${index ? "is-b" : "is-a"}`}>
              <BookOpen size={11} />
              {cite}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function Keep({ s }: { s: Stage }) {
  return (
    <>
      <div className="lp-anim lp-s4-note">
        <div className="lp-s4-note-head">
          <NotebookPen size={14} />
          <strong>{s.noteTitle}</strong>
        </div>
        <p>
          <Typed text={s.note} delay={0.45} step={0.022} />
        </p>
        <div className="lp-s4-tags">
          {s.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      </div>
      <div className="lp-anim lp-s4-page">
        <div className="lp-s4-page-head">
          <span className="lp-s4-kind">{s.pageBadge.split("·")[0].trim()}</span>
        </div>
        <strong className="lp-s4-title">{s.tags[0]}</strong>
        <PageLines count={3} />
        <div className="lp-s4-src">
          <BookOpen size={11} />
          {s.cites[0]}
        </div>
        <PageLines count={2} from={3} />
        <div className="lp-s4-status">
          <span className="lp-s4-review">{s.pageBadge}</span>
          <span className="lp-s4-saved">
            <Cloud size={12} />
            {s.saved}
            <Check size={12} />
          </span>
        </div>
      </div>
    </>
  );
}

function Continue({ s }: { s: Stage }) {
  return (
    <>
      <div className="lp-anim lp-s5-continue">
        <span className="lp-s5-icon">
          <BookOpen size={18} />
        </span>
        <div>
          <em>{s.continueLabel}</em>
          <strong>{s.continueTitle}</strong>
          <span>{s.continueMeta}</span>
        </div>
        <span className="lp-s5-progress">
          <i />
        </span>
      </div>
      <div className="lp-anim lp-s5-questions">
        <div className="lp-s5-card-head">
          <CircleHelp size={13} />
          {s.openQuestions}
        </div>
        <p>{s.openQuestion}</p>
        <p className="is-dim">{s.question}</p>
      </div>
      <div className="lp-anim lp-s5-review">
        <div className="lp-s5-card-head">
          <Sparkles size={13} />
          {s.reviewTitle}
        </div>
        <ol>
          {s.reviewDays.map((day, index) => (
            <li
              key={day}
              className={index === 0 ? "is-now" : ""}
              style={vars({ "--d": `${0.5 + index * 0.15}s` })}
            >
              <i />
              <span>{day}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="lp-anim lp-s5-devices">
        <Laptop size={22} />
        <span className="lp-s5-track">
          <i />
        </span>
        <Tablet size={20} />
        <span className="lp-s5-track is-2">
          <i />
        </span>
        <Smartphone size={18} />
        <em>{s.devices}</em>
      </div>
    </>
  );
}

export default function StoryStage({
  s,
  active,
  excerpt,
  only,
}: {
  s: Stage;
  /** Index of the visible layer. */
  active: number;
  excerpt: string;
  /** Render a single layer (stacked layout). */
  only?: number;
}) {
  const fitRef = useFit();
  const layers = [
    <Collect s={s} key="collect" />,
    <Read s={s} excerpt={excerpt} key="read" />,
    <Verify s={s} key="verify" />,
    <Keep s={s} key="keep" />,
    <Continue s={s} key="continue" />,
  ];
  return (
    <div className="lp-stage" ref={fitRef} aria-hidden="true">
      <div className="lp-stage-canvas">
        <div className="lp-stage-chrome">
          <span className="lp-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="lp-stage-title">{s.window}</span>
          <span className="lp-stage-search">
            <Search size={11} />
          </span>
        </div>
        <div className="lp-stage-side">
          <Image src="/conuo-icon-192.png" alt="" width={22} height={22} />
          <i className="is-active" />
          <i />
          <i />
          <i />
        </div>
        <div className="lp-stage-body">
          {layers.map((layer, index) =>
            only === undefined || only === index ? (
              <div
                key={index}
                className={`lp-stage-layer lp-s${index + 1} ${active === index ? "is-active" : ""}`}
              >
                {layer}
              </div>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}
