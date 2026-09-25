"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { LandingCopy } from "./copy";
import { ensureGsap, scrollToPosition, useInView } from "./motion";
import StoryStage from "./story-stage";
import { vars } from "./ui";

type Props = { t: LandingCopy["story"]; excerpt: string };

const smoothstep = (from: number, to: number, value: number) => {
  const x = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return x * x * (3 - 2 * x);
};

/**
 * Background runs from night to daylight across the section. Rather than
 * cross-fading through grey (unreadable in both text colours), it passes through
 * brand indigo and lavender, and the text colour flips at the jump between them.
 */
const TONE_STOPS: [number, [number, number, number]][] = [
  [0, [7, 6, 26]],
  [0.4, [24, 18, 78]],
  [0.47, [58, 46, 160]],
  [0.53, [216, 210, 255]],
  [0.64, [238, 236, 251]],
  [1, [247, 247, 248]],
];

export function toneColor(t: number) {
  const x = Math.min(1, Math.max(0, t));
  let i = 0;
  while (i < TONE_STOPS.length - 2 && x > TONE_STOPS[i + 1][0]) i += 1;
  const [a, from] = TONE_STOPS[i];
  const [b, to] = TONE_STOPS[i + 1];
  const k = b === a ? 0 : (x - a) / (b - a);
  const channel = (n: number) => Math.round(from[n] + (to[n] - from[n]) * k);
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
}

function applyTone(section: HTMLElement, progress: number, range: [number, number]) {
  const t = smoothstep(range[0], range[1], progress);
  section.style.setProperty("--t", t.toFixed(4));
  section.style.setProperty("--story-bg", toneColor(t));
  section.dataset.tone = t >= 0.5 ? "light" : "dark";
}

function StepText({ step, index }: { step: Props["t"]["steps"][number]; index: number }) {
  return (
    <>
      <span className="lp-story-num lp-mono">{String(index + 1).padStart(2, "0")}</span>
      <span className="lp-story-step-title">{step.title}</span>
    </>
  );
}

function StepDetail({ step }: { step: Props["t"]["steps"][number] }) {
  return (
    <div className="lp-story-detail">
      <div>
        <p>{step.body}</p>
        <ul>
          {step.points.map((point) => (
            <li key={point}>
              <Check size={14} aria-hidden="true" />
              {point}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Desktop: the stage stays pinned while five scroll "beats" play through it. */
function PinnedStory({ t, excerpt }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const pinRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<{ start: number; end: number } | null>(null);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    const pin = pinRef.current;
    if (!section || !pin) return;
    const { ScrollTrigger } = ensureGsap();
    applyTone(section, 0, [0.3, 0.68]);
    const trigger = ScrollTrigger.create({
      trigger: section,
      pin,
      start: "top top",
      end: () => `+=${window.innerHeight * 4.2}`,
      scrub: true,
      anticipatePin: 1,
      invalidateOnRefresh: true,
      onRefresh: (self) => {
        triggerRef.current = { start: self.start, end: self.end };
      },
      onUpdate: (self) => {
        triggerRef.current = { start: self.start, end: self.end };
        applyTone(section, self.progress, [0.3, 0.68]);
        railRef.current?.style.setProperty("transform", `scaleY(${self.progress.toFixed(4)})`);
        const step = Math.min(t.steps.length - 1, Math.floor(self.progress * t.steps.length));
        setActive((current) => (current === step ? current : step));
      },
    });
    return () => trigger.kill(true);
  }, [t.steps.length]);

  const jump = (index: number) => {
    const range = triggerRef.current;
    if (!range) return;
    scrollToPosition(range.start + ((index + 0.5) / t.steps.length) * (range.end - range.start));
  };

  return (
    <section
      id="story"
      className="lp-story is-pinned"
      ref={sectionRef}
      data-tone="dark"
      aria-labelledby="lp-story-title"
    >
      <div className="lp-story-pin" ref={pinRef}>
        <div className="lp-container lp-story-grid">
          <div className="lp-story-copy">
            <p className="lp-eyebrow">{t.eyebrow}</p>
            <h2 className="lp-h2" id="lp-story-title">
              {t.title}
            </h2>
            <div className="lp-story-steps">
              <span className="lp-story-rail" aria-hidden="true">
                <span ref={railRef} />
              </span>
              <ol>
                {t.steps.map((step, index) => (
                  <li
                    key={step.title}
                    className={index === active ? "is-active" : index < active ? "is-done" : ""}
                    aria-current={index === active ? "step" : undefined}
                  >
                    <button type="button" onClick={() => jump(index)}>
                      <StepText step={step} index={index} />
                    </button>
                    <StepDetail step={step} />
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className="lp-story-visual">
            <div className="lp-story-glow" aria-hidden="true" style={vars({ "--step": active })} />
            <StoryStage s={t.stage} active={active} excerpt={excerpt} />
            <p className="lp-story-counter lp-mono" aria-hidden="true">
              <span>{String(active + 1).padStart(2, "0")}</span> /{" "}
              {String(t.steps.length).padStart(2, "0")}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function StackedStep({
  step,
  index,
  stage,
  excerpt,
}: {
  step: Props["t"]["steps"][number];
  index: number;
  stage: Props["t"]["stage"];
  excerpt: string;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const inView = useInView(ref, "0px 0px -25% 0px");
  return (
    <li ref={ref} className={`lp-story-card ${inView ? "is-in" : ""}`}>
      <h3>
        <StepText step={step} index={index} />
      </h3>
      <StepDetail step={step} />
      <StoryStage s={stage} active={inView ? index : -1} only={index} excerpt={excerpt} />
    </li>
  );
}

/** Narrow screens and reduced motion: a simple vertical sequence, no pinning. */
function StackedStory({ t, excerpt }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const { ScrollTrigger } = ensureGsap();
    applyTone(section, 0, [0.22, 0.5]);
    const trigger = ScrollTrigger.create({
      trigger: section,
      start: "top top",
      end: "bottom bottom",
      onUpdate: (self) => applyTone(section, self.progress, [0.22, 0.5]),
    });
    return () => trigger.kill();
  }, []);
  return (
    <section
      id="story"
      className="lp-story is-stacked"
      ref={sectionRef}
      data-tone="dark"
      aria-labelledby="lp-story-title"
    >
      <div className="lp-container">
        <p className="lp-eyebrow">{t.eyebrow}</p>
        <h2 className="lp-h2" id="lp-story-title">
          {t.title}
        </h2>
        <ol className="lp-story-stack">
          {t.steps.map((step, index) => (
            <StackedStep
              key={step.title}
              step={step}
              index={index}
              stage={t.stage}
              excerpt={excerpt}
            />
          ))}
        </ol>
      </div>
    </section>
  );
}

export default function Story({ pinned, ...props }: Props & { pinned: boolean }) {
  return pinned ? (
    <PinnedStory key="pinned" {...props} />
  ) : (
    <StackedStory key="stacked" {...props} />
  );
}
