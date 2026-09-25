"use client";

import { useEffect, useState, type RefObject } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

let registered = false;
export function ensureGsap() {
  if (!registered && typeof window !== "undefined") {
    gsap.registerPlugin(ScrollTrigger);
    registered = true;
  }
  return { gsap, ScrollTrigger };
}

export function matches(query: string) {
  try {
    return typeof window !== "undefined" && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
export const WIDE_LAYOUT = "(min-width: 960px)";
export const FINE_POINTER = "(hover: hover) and (pointer: fine)";

/**
 * Subscribes to a media query. The landing only renders on the client
 * (next/dynamic with ssr: false), so reading it during the first render is safe.
 */
export function useMedia(query: string) {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    let list: MediaQueryList;
    try {
      list = window.matchMedia(query);
    } catch {
      return;
    }
    const update = () => setValue(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return value;
}

/** Adds `is-in` once the element scrolls into view (immediately when IO is missing). */
export function useInView<T extends Element>(
  ref: RefObject<T | null>,
  rootMargin = "0px 0px -12% 0px",
) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      queueMicrotask(() => setInView(true));
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

let lenis: Lenis | null = null;

/** Smooth wheel scrolling driven by the GSAP ticker so ScrollTrigger stays in sync. */
export function startSmoothScroll() {
  const { gsap, ScrollTrigger } = ensureGsap();
  const instance = new Lenis({ autoRaf: false, lerp: 0.11, wheelMultiplier: 0.95 });
  lenis = instance;
  instance.on("scroll", ScrollTrigger.update);
  const tick = (time: number) => instance.raf(time * 1000);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);
  return () => {
    gsap.ticker.remove(tick);
    gsap.ticker.lagSmoothing(500, 33);
    instance.destroy();
    if (lenis === instance) lenis = null;
  };
}

export function setScrollPaused(paused: boolean) {
  if (!lenis) return;
  if (paused) lenis.stop();
  else lenis.start();
}

/** Scrolls to an absolute position, through Lenis when it is running. */
export function scrollToPosition(top: number) {
  const reduce = matches(REDUCED_MOTION);
  if (lenis && !reduce) {
    lenis.scrollTo(top, { duration: 1.2 });
    return;
  }
  window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
}

/** Scrolls to a section id ("top" for the page start). */
export function scrollToSection(id: string) {
  if (id === "top") return scrollToPosition(0);
  const target = document.getElementById(id);
  if (!target) return;
  // Pinned sections sit inside a spacer; measure the outermost box.
  const box = target.closest(".pin-spacer") ?? target;
  scrollToPosition(box.getBoundingClientRect().top + window.scrollY);
}
