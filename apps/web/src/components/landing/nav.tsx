"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import { Menu, X } from "lucide-react";
import type { AuthMode, LandingCopy } from "./copy";
import { scrollToSection, setScrollPaused } from "./motion";

export default function Nav({
  t,
  switchTo,
  switchLabel,
  menuOpen,
  onMenu,
  onToggleLang,
  onAuth,
}: {
  t: LandingCopy["nav"];
  switchTo: string;
  switchLabel: string;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onToggleLang: () => void;
  onAuth: (mode: AuthMode) => void;
}) {
  const headerRef = useRef<HTMLElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The header adopts the tone of whatever section sits beneath it.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const header = headerRef.current;
      if (!header) return;
      const probe = header.offsetHeight / 2;
      let tone = "dark";
      document.querySelectorAll<HTMLElement>(".lp [data-tone]").forEach((section) => {
        const rect = section.getBoundingClientRect();
        if (rect.top <= probe && rect.bottom > probe) tone = section.dataset.tone ?? tone;
      });
      header.dataset.tone = tone;
      header.dataset.scrolled = String(window.scrollY > 12);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progressRef.current?.style.setProperty(
        "transform",
        `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    setScrollPaused(true);
    document.documentElement.classList.add("lp-scroll-locked");
    menuRef.current?.querySelector<HTMLElement>("button, a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onMenu(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      setScrollPaused(false);
      document.documentElement.classList.remove("lp-scroll-locked");
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, onMenu]);

  const go = (id: string) => {
    onMenu(false);
    scrollToSection(id);
  };

  return (
    <>
      <header className="lp-nav" ref={headerRef} data-tone="dark" data-scrolled="false">
        <div className="lp-nav-inner">
          <button
            type="button"
            className="lp-nav-brand"
            onClick={() => go("top")}
            aria-label={t.home}
          >
            <Image src="/conuo-icon-192.png" alt="" width={28} height={28} priority />
            <span>Conuo</span>
          </button>
          <nav className="lp-nav-links" aria-label="Conuo">
            {t.links.map((link) => (
              <button type="button" key={link.id} onClick={() => go(link.id)}>
                {link.label}
              </button>
            ))}
          </nav>
          <div className="lp-nav-actions">
            <button
              type="button"
              className="lp-lang"
              onClick={onToggleLang}
              aria-label={switchLabel}
              title={switchLabel}
            >
              {switchTo}
            </button>
            <button type="button" className="lp-nav-start" onClick={() => onAuth("start")}>
              {t.start}
            </button>
            <button
              type="button"
              className="lp-nav-burger"
              aria-label={menuOpen ? t.closeMenu : t.menu}
              aria-expanded={menuOpen}
              aria-controls="lp-mobile-menu"
              onClick={() => onMenu(!menuOpen)}
            >
              {menuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
        <span className="lp-nav-progress" ref={progressRef} aria-hidden="true" />
      </header>

      <div
        id="lp-mobile-menu"
        className={`lp-menu ${menuOpen ? "is-open" : ""}`}
        ref={menuRef}
        hidden={!menuOpen}
        data-lenis-prevent
      >
        <nav aria-label="Conuo">
          {t.links.map((link, index) => (
            <button type="button" key={link.id} onClick={() => go(link.id)}>
              <span className="lp-mono">{String(index + 1).padStart(2, "0")}</span>
              {link.label}
            </button>
          ))}
        </nav>
        <div className="lp-menu-actions">
          <button
            type="button"
            className="lp-btn lp-btn-glow"
            onClick={() => (onMenu(false), onAuth("start"))}
          >
            {t.start}
          </button>
        </div>
      </div>
    </>
  );
}
