"use client";

import { useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import {
  ArrowRight,
  BookCheck,
  BookOpen,
  ChevronDown,
  KeyRound,
  PackageOpen,
  UserRoundCheck,
} from "lucide-react";
import type { AuthMode, LandingCopy } from "./copy";
import { ensureGsap, scrollToSection } from "./motion";
import { FileGlyph, MagneticButton, SectionHeading } from "./ui";

/* ------------------------------------------------------------------ principles */

const PRINCIPLE_ICONS = [BookCheck, UserRoundCheck, KeyRound, PackageOpen];

export function Principles({ t, reduced }: { t: LandingCopy["principles"]; reduced: boolean }) {
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const section = sectionRef.current;
    if (!section || reduced) return;
    const { gsap } = ensureGsap();
    const context = gsap.context(() => {
      const scrollTrigger = {
        trigger: section,
        start: "top bottom",
        end: "bottom top",
        scrub: 0.4,
      };
      gsap.fromTo(
        ".lp-marquee-row.is-a .lp-marquee-track",
        { xPercent: 0 },
        { xPercent: -28, ease: "none", scrollTrigger },
      );
      gsap.fromTo(
        ".lp-marquee-row.is-b .lp-marquee-track",
        { xPercent: -28 },
        { xPercent: 0, ease: "none", scrollTrigger },
      );
      gsap.from(".lp-principle", {
        y: 40,
        opacity: 0,
        duration: 0.9,
        ease: "expo.out",
        stagger: 0.08,
        scrollTrigger: { trigger: ".lp-principles-grid", start: "top 82%" },
      });
    }, section);
    return () => context.revert();
  }, [reduced]);

  const words = [...t.marquee, ...t.marquee, ...t.marquee];
  return (
    <section
      id="principles"
      className="lp-principles"
      data-tone="light"
      ref={sectionRef}
      aria-labelledby="lp-principles-title"
    >
      <div className="lp-marquee" aria-hidden="true">
        {(["is-a", "is-b"] as const).map((row) => (
          <div key={row} className={`lp-marquee-row ${row}`}>
            <div className="lp-marquee-track">
              {words.map((word, index) => (
                <span key={index} className={index % 2 ? "is-outline" : ""}>
                  {word}
                  <i />
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="lp-container">
        <SectionHeading
          eyebrow={t.eyebrow}
          title={t.title}
          id="lp-principles-title"
          align="center"
        />
        <ol className="lp-principles-grid">
          {t.items.map((item, index) => {
            const Icon = PRINCIPLE_ICONS[index % PRINCIPLE_ICONS.length];
            return (
              <li key={item.title} className="lp-principle">
                <span className="lp-principle-num lp-mono">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="lp-principle-icon" aria-hidden="true">
                  <Icon size={20} />
                </span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ platforms */

function MiniApp({
  screen,
  variant,
  greeting,
}: {
  screen: LandingCopy["platforms"]["screen"];
  variant: "laptop" | "tablet" | "phone";
  greeting: string;
}) {
  const kinds = ["pdf", "docx", "md"] as const;
  return (
    <div className={`lp-mini is-${variant}`}>
      {variant !== "phone" ? (
        <div className="lp-mini-side">
          <Image src="/conuo-icon-192.png" alt="" width={16} height={16} />
          <i className="is-active" />
          <i />
          <i />
          <i />
        </div>
      ) : null}
      <div className="lp-mini-main">
        <strong className="lp-mini-greeting">{greeting}</strong>
        <div className="lp-mini-continue">
          <span className="lp-mini-continue-icon">
            <BookOpen size={variant === "phone" ? 10 : 12} />
          </span>
          <div>
            <em>{screen.continue}</em>
            <span>{screen.items[0]}</span>
          </div>
          <i className="lp-mini-progress" />
        </div>
        <em className="lp-mini-label">{screen.recent}</em>
        <ul>
          {screen.items.map((item, index) => (
            <li key={item}>
              <FileGlyph kind={kinds[index % kinds.length]} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Platforms({ t, reduced }: { t: LandingCopy["platforms"]; reduced: boolean }) {
  const sectionRef = useRef<HTMLElement>(null);
  // The mock screens greet the visitor for their own time of day.
  const [hour] = useState(() => new Date().getHours());
  const greeting = t.screen.greetings[hour < 12 ? 0 : hour < 18 ? 1 : 2];
  useEffect(() => {
    const section = sectionRef.current;
    if (!section || reduced) return;
    const { gsap } = ensureGsap();
    const context = gsap.context(() => {
      const scrollTrigger = {
        trigger: section,
        start: "top bottom",
        end: "bottom top",
        scrub: 0.6,
      };
      gsap.fromTo(".lp-device.is-laptop", { y: 60 }, { y: -30, ease: "none", scrollTrigger });
      gsap.fromTo(
        ".lp-device.is-tablet",
        { y: 130, rotate: 4 },
        { y: -50, rotate: -2, ease: "none", scrollTrigger },
      );
      gsap.fromTo(
        ".lp-device.is-phone",
        { y: 200, rotate: -6 },
        { y: -90, rotate: 3, ease: "none", scrollTrigger },
      );
    }, section);
    return () => context.revert();
  }, [reduced]);

  return (
    <section
      id="platforms"
      className="lp-platforms"
      data-tone="light"
      ref={sectionRef}
      aria-labelledby="lp-platforms-title"
    >
      <div className="lp-container lp-platforms-grid">
        <div className="lp-platforms-copy">
          <SectionHeading
            eyebrow={t.eyebrow}
            title={t.title}
            lead={t.lead}
            id="lp-platforms-title"
          />
          <ul className="lp-platform-list">
            {t.items.map((item) => (
              <li key={item.name}>
                <span className={`lp-status-dot is-${item.status}`} aria-hidden="true" />
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.detail}</span>
                </div>
                <em className={`lp-status is-${item.status}`}>{item.statusLabel}</em>
              </li>
            ))}
          </ul>
          <p className="lp-platforms-note">{t.note}</p>
        </div>
        <div className="lp-devices" aria-hidden="true">
          <div className="lp-device is-laptop">
            <div className="lp-device-screen">
              <MiniApp screen={t.screen} variant="laptop" greeting={greeting} />
            </div>
            <div className="lp-device-base" />
          </div>
          <div className="lp-device is-tablet">
            <div className="lp-device-screen">
              <MiniApp screen={t.screen} variant="tablet" greeting={greeting} />
            </div>
          </div>
          <div className="lp-device is-phone">
            <div className="lp-device-screen">
              <MiniApp screen={t.screen} variant="phone" greeting={greeting} />
            </div>
          </div>
          <div className="lp-devices-halo" />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ faq */

export function Faq({ t }: { t: LandingCopy["faq"] }) {
  const [open, setOpen] = useState(0);
  const baseId = useId();
  return (
    <section id="faq" className="lp-faq" data-tone="light" aria-labelledby="lp-faq-title">
      <div className="lp-container lp-faq-grid">
        <SectionHeading eyebrow={t.eyebrow} title={t.title} id="lp-faq-title" />
        <div className="lp-faq-list">
          {t.items.map((item, index) => {
            const expanded = open === index;
            const panelId = `${baseId}-panel-${index}`;
            const buttonId = `${baseId}-button-${index}`;
            return (
              <div key={item.q} className={`lp-faq-item ${expanded ? "is-open" : ""}`}>
                <h3>
                  <button
                    type="button"
                    id={buttonId}
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => setOpen(expanded ? -1 : index)}
                  >
                    <span>{item.q}</span>
                    <ChevronDown size={18} aria-hidden="true" />
                  </button>
                </h3>
                <div className="lp-faq-panel" id={panelId} role="region" aria-labelledby={buttonId}>
                  <div>
                    <p>{item.a}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ closing */

export function FinalCta({
  t,
  onAuth,
}: {
  t: LandingCopy["cta"];
  onAuth: (mode: AuthMode) => void;
}) {
  return (
    <section className="lp-cta" data-tone="dark" aria-labelledby="lp-cta-title">
      <div className="lp-cta-stars" aria-hidden="true" />
      <div className="lp-container lp-cta-inner">
        <div className="lp-cta-orb" aria-hidden="true">
          <span className="lp-cta-ring" />
          <span className="lp-cta-ring is-2" />
          <Image src="/conuo-icon-512.png" alt="" width={112} height={112} />
        </div>
        <h2 className="lp-cta-title" id="lp-cta-title">
          <span>{t.title[0]}</span>
          <span className="is-accent">{t.title[1]}</span>
        </h2>
        <p className="lp-cta-lead">{t.lead}</p>
        <div className="lp-cta-actions">
          <MagneticButton className="lp-btn lp-btn-glow" onClick={() => onAuth("signup")}>
            {t.primary}
            <ArrowRight size={18} aria-hidden="true" />
          </MagneticButton>
          <button type="button" className="lp-btn lp-btn-ghost" onClick={() => onAuth("login")}>
            {t.secondary}
          </button>
        </div>
      </div>
    </section>
  );
}

export function Footer({
  t,
  langName,
  switchTo,
  switchLabel,
  onToggleLang,
  onAuth,
}: {
  t: LandingCopy["footer"];
  langName: string;
  switchTo: string;
  switchLabel: string;
  onToggleLang: () => void;
  onAuth: (mode: AuthMode) => void;
}) {
  const follow = (target: string) => {
    if (target === "auth:login") onAuth("login");
    else if (target === "auth:signup") onAuth("signup");
    else scrollToSection(target);
  };
  return (
    <footer className="lp-footer" data-tone="dark">
      <div className="lp-container">
        <div className="lp-footer-top">
          <div className="lp-footer-brand">
            <span className="lp-footer-logo">
              <Image src="/conuo-icon-192.png" alt="" width={32} height={32} />
              Conuo
            </span>
            <p>{t.tagline}</p>
          </div>
          <div className="lp-footer-groups">
            {t.groups.map((group) => (
              <div key={group.title}>
                <h3>{group.title}</h3>
                <ul>
                  {group.links.map((link) => (
                    <li key={link.target}>
                      <button type="button" onClick={() => follow(link.target)}>
                        {link.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="lp-footer-wordmark" aria-hidden="true">
          Conuo
        </div>
        <div className="lp-footer-bottom">
          <span>{t.rights}</span>
          <span>{t.note}</span>
          <button
            type="button"
            className="lp-lang is-footer"
            onClick={onToggleLang}
            aria-label={switchLabel}
          >
            <span>{langName}</span>
            <span aria-hidden="true">·</span>
            <span>{switchTo}</span>
          </button>
        </div>
      </div>
      <span className="lp-footer-glow" aria-hidden="true" />
    </footer>
  );
}
