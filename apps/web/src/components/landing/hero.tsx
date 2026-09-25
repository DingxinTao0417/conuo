"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Play } from "lucide-react";
import type { Lang, LandingCopy } from "./copy";
import { splitHeadline } from "./text";
import type { HeroScene } from "./hero-scene";
import { ensureGsap } from "./motion";
import { MagneticButton, vars } from "./ui";

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export default function Hero({
  t,
  lang,
  reduced,
  onStart,
  onExplore,
}: {
  t: LandingCopy["hero"];
  lang: Lang;
  reduced: boolean;
  onStart: () => void;
  onExplore: () => void;
}) {
  const wrapRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<HTMLDivElement>(null);
  const cueRef = useRef<HTMLButtonElement>(null);
  const sceneRef = useRef<HeroScene | null>(null);
  const [webgl, setWebgl] = useState<"pending" | "ready" | "failed">("pending");

  // Each highlighted unit shows its own slice of one shared gradient.
  const { lines, highlightCount } = useMemo(() => {
    let index = 0;
    const split = t.titleLines.map((line) =>
      splitHeadline(line, t.highlight, lang).map((unit) => ({
        ...unit,
        slice: unit.highlight && !unit.space ? index++ : -1,
      })),
    );
    return { lines: split, highlightCount: index };
  }, [t.titleLines, t.highlight, lang]);

  // WebGL scene lifecycle. Creation is deferred a tick so StrictMode's
  // mount/unmount/mount never builds two renderers on the same canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let cancelled = false;
    let scene: HeroScene | null = null;
    const timer = window.setTimeout(async () => {
      try {
        const { createHeroScene } = await import("./hero-scene");
        const created = await createHeroScene({
          canvas,
          iconUrl: "/conuo-icon-192.png",
          reducedMotion: reduced,
        });
        if (cancelled) {
          created?.dispose();
          return;
        }
        scene = created;
        sceneRef.current = created;
        setWebgl(created ? "ready" : "failed");
      } catch {
        if (!cancelled) setWebgl("failed");
      }
    }, 0);
    const onResize = () => scene?.resize();
    window.addEventListener("resize", onResize);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => scene?.setActive(Boolean(entry?.isIntersecting)));
    observer?.observe(wrap);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      scene?.dispose();
      sceneRef.current = null;
    };
  }, [reduced]);

  // Intro reveal and the scroll-scrubbed hand-off into the knowledge network.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { gsap } = ensureGsap();
    const context = gsap.context(() => {
      if (!reduced) {
        gsap.from(".lp-hero-char", {
          yPercent: 115,
          opacity: 0,
          rotate: 4,
          duration: 1.25,
          ease: "expo.out",
          stagger: 0.05,
          delay: 0.25,
        });
        gsap.from(".lp-hero-reveal", {
          y: 26,
          opacity: 0,
          duration: 1.1,
          ease: "expo.out",
          stagger: 0.09,
          delay: 0.75,
        });
      }
      const timeline = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: {
          trigger: wrap,
          start: "top top",
          end: "bottom bottom",
          scrub: reduced ? true : 0.5,
          onUpdate: (self) => {
            if (!reduced) sceneRef.current?.setMorph(clamp01((self.progress - 0.1) / 0.5));
            sceneRef.current?.setOpacity(1 - clamp01((self.progress - 0.9) / 0.1) * 0.35);
          },
        },
      });
      timeline
        .to(cueRef.current, { opacity: 0, duration: 0.06 }, 0)
        .to(
          contentRef.current,
          reduced
            ? { opacity: 0, duration: 0.25 }
            : { opacity: 0, y: -90, scale: 0.97, filter: "blur(6px)", duration: 0.3 },
          0.02,
        )
        .fromTo(
          ".lp-hero-bridge-line",
          { opacity: 0, y: reduced ? 0 : 50 },
          { opacity: 1, y: 0, duration: 0.18, stagger: 0.06 },
          0.46,
        )
        .fromTo(".lp-hero-bridge-eyebrow", { opacity: 0 }, { opacity: 1, duration: 0.12 }, 0.44)
        .to(bridgeRef.current, { opacity: 0, y: reduced ? 0 : -60, duration: 0.14 }, 0.86);
    }, wrap);
    return () => context.revert();
  }, [reduced, lang]);

  return (
    <section
      className="lp-hero"
      id="top"
      data-tone="dark"
      ref={wrapRef}
      aria-labelledby="lp-hero-title"
    >
      <div className="lp-hero-sticky">
        <div className="lp-hero-aurora" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="lp-hero-grid" aria-hidden="true" />
        <canvas
          ref={canvasRef}
          className={`lp-hero-canvas ${webgl === "ready" ? "is-ready" : ""}`}
          aria-hidden="true"
        />
        {webgl === "failed" ? (
          <div className="lp-hero-fallback" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/conuo-icon-512.png" alt="" width={220} height={220} />
          </div>
        ) : null}
        <div className="lp-hero-grain" aria-hidden="true" />

        <div className="lp-container lp-hero-layout">
          <div className="lp-hero-content" ref={contentRef}>
            <p className="lp-badge lp-hero-reveal">
              <span className="lp-badge-dot" aria-hidden="true" />
              {t.badge}
            </p>
            <h1 className="lp-hero-title" id="lp-hero-title" data-lang={lang}>
              <span className="lp-sr">{t.titleLines.join("")}</span>
              {lines.map((units, lineIndex) => (
                <span className="lp-hero-line" key={`${lang}-${lineIndex}`} aria-hidden="true">
                  {units.map((unit, unitIndex) =>
                    unit.space ? (
                      <span key={unitIndex}> </span>
                    ) : (
                      <span className="lp-char-mask" key={unitIndex}>
                        <span
                          className={`lp-hero-char ${unit.highlight ? "is-highlight" : ""}`}
                          style={
                            unit.slice >= 0
                              ? vars({ "--i": unit.slice, "--n": highlightCount })
                              : undefined
                          }
                        >
                          {unit.text}
                        </span>
                      </span>
                    ),
                  )}
                </span>
              ))}
            </h1>
            <p className="lp-hero-lead lp-hero-reveal">{t.lead}</p>
            <div className="lp-hero-actions lp-hero-reveal">
              <MagneticButton className="lp-btn lp-btn-glow" onClick={onStart}>
                {t.primary}
                <ArrowRight size={18} aria-hidden="true" />
              </MagneticButton>
              <MagneticButton className="lp-btn lp-btn-ghost" onClick={onExplore} strength={0.18}>
                <span className="lp-play" aria-hidden="true">
                  <Play size={12} fill="currentColor" />
                </span>
                {t.secondary}
              </MagneticButton>
            </div>
            <ol className="lp-hero-flow lp-hero-reveal" aria-label={t.flow.join(" → ")}>
              {t.flow.map((step, index) => (
                <li key={step} style={vars({ "--d": `${index * 0.6}s` })}>
                  <span className="lp-mono">{String(index + 1).padStart(2, "0")}</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="lp-hero-bridge" ref={bridgeRef} aria-hidden="true">
          <p className="lp-hero-bridge-eyebrow lp-mono">{t.bridgeEyebrow}</p>
          <p className="lp-hero-bridge-line">{t.bridge[0]}</p>
          <p className="lp-hero-bridge-line is-accent">{t.bridge[1]}</p>
        </div>

        <button type="button" className="lp-scroll-cue" ref={cueRef} onClick={onExplore}>
          <span>{t.scroll}</span>
          <ArrowDown size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
