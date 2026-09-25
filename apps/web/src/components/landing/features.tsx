"use client";

import { useRef, type PointerEvent, type ReactNode } from "react";
import Image from "next/image";
import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  Check,
  Cloud,
  FileStack,
  GitBranch,
  Link2,
  Monitor,
  Repeat,
  ScanSearch,
  Search,
  Smartphone,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import type { LandingCopy } from "./copy";
import { useInView } from "./motion";
import { FileGlyph, SectionHeading, vars } from "./ui";

type Art = LandingCopy["features"]["art"];

function ImportArt() {
  const kinds = ["pdf", "docx", "md", "txt", "web"] as const;
  return (
    <div className="lp-art lp-art-import" aria-hidden="true">
      <div className="lp-orbit">
        {kinds.map((kind, index) => (
          <span
            key={kind}
            className="lp-orbit-item"
            style={vars({ "--a": `${(360 / kinds.length) * index}deg` })}
          >
            <span className="lp-orbit-counter">
              <FileGlyph kind={kind} />
            </span>
          </span>
        ))}
      </div>
      <div className="lp-orbit-ring is-2" />
      <div className="lp-orbit-core">
        <Image src="/conuo-icon-192.png" alt="" width={56} height={56} />
      </div>
    </div>
  );
}

function RegionArt({ art }: { art: Art }) {
  return (
    <div className="lp-art lp-art-region" aria-hidden="true">
      <div className="lp-region-page">
        <i className="lp-line" style={vars({ "--w": "70%" })} />
        <i className="lp-line" style={vars({ "--w": "88%" })} />
        <svg viewBox="0 0 160 80" className="lp-region-chart">
          <path d="M8 70 H152" />
          <path d="M8 70 V8" />
          <path className="lp-region-curve" d="M12 62 C 40 60, 52 18, 80 22 S 124 58, 150 14" />
          {[28, 58, 92, 124].map((x, index) => (
            <rect
              key={x}
              x={x}
              y={70 - [18, 36, 26, 44][index]}
              width="12"
              height={[18, 36, 26, 44][index]}
              rx="2"
            />
          ))}
        </svg>
        <i className="lp-line" style={vars({ "--w": "80%" })} />
        <span className="lp-region-box">
          <span className="lp-region-handle" />
        </span>
      </div>
      <div className="lp-region-actions">
        {art.regionActions.map((action, index) => (
          <span key={action} style={vars({ "--d": `${1.4 + index * 0.12}s` })}>
            {
              [
                <Sparkles key="s" size={11} />,
                <ScanSearch key="q" size={11} />,
                <WandSparkles key="p" size={11} />,
              ][index]
            }
            {action}
          </span>
        ))}
      </div>
    </div>
  );
}

function CiteArt({ art }: { art: Art }) {
  return (
    <div className="lp-art lp-art-cite" aria-hidden="true">
      <p className="lp-cite-quote">
        <mark>{art.citeQuote}</mark>
      </p>
      <span className="lp-cite-jump">
        <Link2 size={12} />
        ¶2 · p.12
      </span>
    </div>
  );
}

function OrganizeArt({ art }: { art: Art }) {
  return (
    <div className="lp-art lp-art-organize" aria-hidden="true">
      {art.organizeSteps.map((step, index) => (
        <div key={step} className="lp-organize-step" style={vars({ "--d": `${index * 0.5}s` })}>
          <span className="lp-organize-icon">
            {
              [
                <WandSparkles key="a" size={14} />,
                <BrainCircuit key="b" size={14} />,
                <Check key="c" size={14} />,
              ][index]
            }
          </span>
          <span>{step}</span>
          {index < art.organizeSteps.length - 1 ? (
            <ArrowRight className="lp-organize-arrow" size={14} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

const NODES = [
  { x: 100, y: 58 },
  { x: 36, y: 30 },
  { x: 166, y: 28 },
  { x: 44, y: 104 },
  { x: 160, y: 104 },
];
const LINKS: [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 3],
  [2, 4],
];

function RelationsArt({ art }: { art: Art }) {
  return (
    <div className="lp-art lp-art-relations" aria-hidden="true">
      <svg viewBox="0 0 200 132">
        {LINKS.map(([a, b], index) => (
          <line
            key={index}
            x1={NODES[a].x}
            y1={NODES[a].y}
            x2={NODES[b].x}
            y2={NODES[b].y}
            className={index > 3 ? "is-dashed" : ""}
            style={vars({ "--d": `${index * 0.14}s` })}
          />
        ))}
        {NODES.map((node, index) => (
          <g
            key={index}
            className={`lp-node is-${index}`}
            style={vars({ "--d": `${0.3 + index * 0.1}s` })}
          >
            <circle cx={node.x} cy={node.y} r={index ? 5 : 8} />
            <text
              x={node.x}
              y={node.y + (index === 0 ? 22 : index < 3 ? -11 : 18)}
              textAnchor="middle"
            >
              {art.relations[index]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function ReviewArt({ art }: { art: Art }) {
  // Retention decays, and each review lifts it back up with a slower decay.
  const path =
    "M 20 18 C 36 60, 44 72, 58 76 L 58 20 C 80 50, 92 58, 110 62 L 110 22 C 140 40, 160 46, 190 50 L 190 24 C 214 32, 240 36, 270 38";
  return (
    <div className="lp-art lp-art-review" aria-hidden="true">
      <svg viewBox="0 0 280 100">
        <path className="lp-review-grid" d="M 20 90 H 272 M 20 90 V 8" />
        <path className="lp-review-curve" d={path} />
        {[58, 110, 190].map((x, index) => (
          <circle
            key={x}
            cx={x}
            cy={[20, 22, 24][index]}
            r="4.5"
            style={vars({ "--d": `${0.7 + index * 0.35}s` })}
          />
        ))}
        <text x="24" y="14">
          {art.reviewAxis[0]}
        </text>
        <text x="268" y="84" textAnchor="end">
          {art.reviewAxis[1]}
        </text>
      </svg>
    </div>
  );
}

function SearchArt({ art }: { art: Art }) {
  return (
    <div className="lp-art lp-art-search" aria-hidden="true">
      <div className="lp-search-box">
        <Search size={14} />
        <span className="lp-search-typed">{art.searchQuery}</span>
      </div>
      <ul>
        {art.searchResults.map((result, index) => (
          <li key={result} style={vars({ "--d": `${1.2 + index * 0.12}s` })}>
            {
              [
                <BookOpen key="a" size={12} />,
                <FileStack key="b" size={12} />,
                <GitBranch key="c" size={12} />,
              ][index]
            }
            {result}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CloudArt({ art }: { art: Art }) {
  return (
    <div className="lp-art lp-art-cloud" aria-hidden="true">
      <span className="lp-cloud-device">
        <Monitor size={20} />
      </span>
      <span className="lp-cloud-wire is-left">
        <i />
      </span>
      <span className="lp-cloud-core">
        <Cloud size={26} />
        <span className="lp-cloud-state">
          <em>{art.cloudStates[0]}</em>
          <strong>
            <Check size={11} />
            {art.cloudStates[1]}
          </strong>
        </span>
      </span>
      <span className="lp-cloud-wire is-right">
        <i />
      </span>
      <span className="lp-cloud-device">
        <Smartphone size={18} />
      </span>
    </div>
  );
}

function Tile({
  id,
  span,
  icon,
  title,
  body,
  children,
}: {
  id: string;
  span: string;
  icon: ReactNode;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <article className={`lp-tile is-${id} ${span}`}>
      <div className="lp-tile-art">{children}</div>
      <div className="lp-tile-copy">
        <h3>
          <span className="lp-tile-icon" aria-hidden="true">
            {icon}
          </span>
          {title}
        </h3>
        <p>{body}</p>
      </div>
    </article>
  );
}

export default function Features({ t }: { t: LandingCopy["features"] }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const inView = useInView(gridRef, "0px 0px -18% 0px");
  const { items, art } = t;

  const spotlight = (event: PointerEvent<HTMLDivElement>) => {
    const tile = (event.target as HTMLElement).closest<HTMLElement>(".lp-tile");
    if (!tile) return;
    const rect = tile.getBoundingClientRect();
    tile.style.setProperty("--px", `${event.clientX - rect.left}px`);
    tile.style.setProperty("--py", `${event.clientY - rect.top}px`);
  };

  return (
    <section
      id="features"
      className="lp-features"
      data-tone="light"
      aria-labelledby="lp-features-title"
    >
      <div className="lp-container">
        <SectionHeading eyebrow={t.eyebrow} title={t.title} lead={t.lead} id="lp-features-title" />
        <div
          ref={gridRef}
          className={`lp-bento ${inView ? "is-in" : ""}`}
          onPointerMove={spotlight}
        >
          <Tile id="import" span="is-w7" icon={<FileStack size={16} />} {...items.import}>
            <ImportArt />
          </Tile>
          <Tile id="region" span="is-w5" icon={<ScanSearch size={16} />} {...items.region}>
            <RegionArt art={art} />
          </Tile>
          <Tile id="cite" span="is-w4" icon={<Link2 size={16} />} {...items.cite}>
            <CiteArt art={art} />
          </Tile>
          <Tile id="organize" span="is-w4" icon={<WandSparkles size={16} />} {...items.organize}>
            <OrganizeArt art={art} />
          </Tile>
          <Tile id="relations" span="is-w4" icon={<GitBranch size={16} />} {...items.relations}>
            <RelationsArt art={art} />
          </Tile>
          <Tile id="review" span="is-w5" icon={<Repeat size={16} />} {...items.review}>
            <ReviewArt art={art} />
          </Tile>
          <Tile id="search" span="is-w3" icon={<Search size={16} />} {...items.search}>
            <SearchArt art={art} />
          </Tile>
          <Tile id="cloud" span="is-w4" icon={<Cloud size={16} />} {...items.cloud}>
            <CloudArt art={art} />
          </Tile>
        </div>
      </div>
    </section>
  );
}
