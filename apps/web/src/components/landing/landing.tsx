"use client";

import { useCallback, useEffect, useState } from "react";
import "lenis/dist/lenis.css";
import "./landing.css";
import "./landing-sections.css";
import { LANG_STORAGE_KEY, initialLang, landingCopy, type AuthMode, type Lang } from "./copy";
import AskDemo from "./demo";
import { landingMono, landingSans } from "./fonts";
import Features from "./features";
import Hero from "./hero";
import {
  REDUCED_MOTION,
  WIDE_LAYOUT,
  ensureGsap,
  scrollToSection,
  setScrollPaused,
  startSmoothScroll,
  useMedia,
} from "./motion";
import Nav from "./nav";
import { Faq, FinalCta, Footer, Platforms, Principles } from "./sections";
import Story from "./story";

export type LandingProps = {
  /** Opens the account dialog owned by the cloud entry. */
  onAuth: (mode: AuthMode, lang: Lang) => void;
  /** True while a modal (the account dialog) sits above the page. */
  paused?: boolean;
};

/**
 * Public homepage shown to signed-out visitors. It is purely presentational:
 * authentication stays in WebCloudEntry, which lazy-loads this module so the
 * signed-in workspace never ships three.js, GSAP or Lenis.
 */
export default function Landing({ onAuth, paused = false }: LandingProps) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [menuOpen, setMenuOpen] = useState(false);
  const reduced = useMedia(REDUCED_MOTION);
  const wide = useMedia(WIDE_LAYOUT);
  const t = landingCopy[lang];

  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang === "zh" ? "zh-CN" : "en";
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      // A blocked storage area only means the choice is not remembered.
    }
  }, [lang]);

  // Page-level lifecycle: smooth scrolling, and a clean hand-back to the workspace.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("lp-root");
    const stop = reduced ? () => {} : startSmoothScroll();
    return () => {
      stop();
      root.classList.remove("lp-root", "lp-scroll-locked");
      root.lang = "zh-CN";
      window.scrollTo(0, 0);
    };
  }, [reduced]);

  useEffect(() => {
    setScrollPaused(paused);
  }, [paused]);

  // Text length changes with the language, and web fonts shift layout once loaded.
  useEffect(() => {
    const { ScrollTrigger } = ensureGsap();
    const refresh = () => ScrollTrigger.refresh();
    const timer = window.setTimeout(refresh, 120);
    document.fonts?.ready.then(refresh).catch(() => {});
    return () => window.clearTimeout(timer);
  }, [lang, wide, reduced]);

  useEffect(
    () => () => {
      const { ScrollTrigger } = ensureGsap();
      ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
    },
    [],
  );

  const auth = useCallback((mode: AuthMode) => onAuth(mode, lang), [onAuth, lang]);
  const toggleLang = useCallback(() => setLang((current) => (current === "zh" ? "en" : "zh")), []);

  return (
    <div className={`lp ${landingSans.variable} ${landingMono.variable}`} data-lang={lang}>
      <a
        className="lp-skip"
        href="#lp-main"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("lp-main");
          main?.focus();
          scrollToSection("story");
        }}
      >
        {t.meta.skip}
      </a>
      <div className="lp-curtain" aria-hidden="true" />
      <Nav
        t={t.nav}
        switchTo={t.meta.switchTo}
        switchLabel={t.meta.switchLabel}
        menuOpen={menuOpen}
        onMenu={setMenuOpen}
        onToggleLang={toggleLang}
        onAuth={auth}
      />
      <main id="lp-main" tabIndex={-1}>
        <Hero
          t={t.hero}
          lang={lang}
          reduced={reduced}
          onStart={() => auth("signup")}
          onExplore={() => scrollToSection("story")}
        />
        <Story t={t.story} excerpt={t.demo.paragraphs[1].text} pinned={wide && !reduced} />
        <AskDemo key={lang} t={t.demo} lang={lang} reduced={reduced} />
        <Features t={t.features} />
        <Principles t={t.principles} reduced={reduced} />
        <Platforms t={t.platforms} reduced={reduced} />
        <Faq t={t.faq} />
        <FinalCta t={t.cta} onAuth={auth} />
      </main>
      <Footer
        t={t.footer}
        langName={t.meta.langName}
        switchTo={t.meta.switchTo}
        switchLabel={t.meta.switchLabel}
        onToggleLang={toggleLang}
        onAuth={auth}
      />
    </div>
  );
}
