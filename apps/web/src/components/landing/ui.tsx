"use client";

import { useRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { FINE_POINTER, REDUCED_MOTION, matches } from "./motion";

/** Inline CSS custom properties without widening every style object to `any`. */
export function vars(values: Record<string, string | number>): CSSProperties {
  return values as CSSProperties;
}

type MagneticProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  strength?: number;
};

/** A button that leans toward the pointer on fine-pointer devices. */
export function MagneticButton({
  children,
  strength = 0.28,
  className = "",
  ...rest
}: MagneticProps) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={`lp-magnetic ${className}`.trim()}
      onPointerMove={(event) => {
        rest.onPointerMove?.(event);
        const element = ref.current;
        if (!element || !matches(FINE_POINTER) || matches(REDUCED_MOTION)) return;
        const rect = element.getBoundingClientRect();
        const x = event.clientX - (rect.left + rect.width / 2);
        const y = event.clientY - (rect.top + rect.height / 2);
        element.style.setProperty("--mx", `${(x * strength).toFixed(1)}px`);
        element.style.setProperty("--my", `${(y * strength).toFixed(1)}px`);
      }}
      onPointerLeave={(event) => {
        rest.onPointerLeave?.(event);
        ref.current?.style.setProperty("--mx", "0px");
        ref.current?.style.setProperty("--my", "0px");
      }}
    >
      <span className="lp-magnetic-inner">{children}</span>
    </button>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lead,
  align = "left",
  id,
}: {
  eyebrow: string;
  title: string;
  lead?: string;
  align?: "left" | "center";
  id?: string;
}) {
  return (
    <header className={`lp-section-heading is-${align}`}>
      <p className="lp-eyebrow">{eyebrow}</p>
      <h2 className="lp-h2" id={id}>
        {title}
      </h2>
      {lead ? <p className="lp-lead">{lead}</p> : null}
    </header>
  );
}

/** Colored file badge matching the workspace's content accents. */
export function FileGlyph({ kind }: { kind: "pdf" | "docx" | "md" | "txt" | "web" }) {
  const label = { pdf: "PDF", docx: "DOC", md: "MD", txt: "TXT", web: "WEB" }[kind];
  return (
    <span className={`lp-file-glyph is-${kind}`} aria-hidden="true">
      {label}
    </span>
  );
}
