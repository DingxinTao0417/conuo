<p align="center">
  <img src="assets/conuo-logo.png" width="120" height="120" alt="Conuo logo: companion pages forming the letter C" />
</p>

<h1 align="center">Conuo · 可诺</h1>

<p align="center"><strong>Learn it, together.</strong></p>

<p align="center">An AI learning companion centered on your personal library</p>

<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>

<p align="center">
  <a href="docs/PRD.md">Product requirements</a> ·
  <a href="docs/TECH_STACK.md">Technical plan</a> ·
  <a href="docs/TRAE_DESIGN_PROMPT.md">Page design</a> ·
  <a href="assets/conuo-logo.png">Logo</a>
</p>

---

Conuo is designed to organize files, web pages, and notes into a searchable personal knowledge base with clear links to its sources. Ask AI questions while reading, check the original material, save your own understanding, and pick up where you left off.

> **Project status: product planning and page design.** This repository contains product requirements, a technical plan, page design prompts, and the logo. Design resources and page prototypes are maintained locally and excluded from Git. A Next.js application has not yet been created. The first release will be a responsive web app.

## Core capabilities

The following features are planned for the first release and have not yet been implemented.

| Capability | Intended experience |
| --- | --- |
| Unified library | Import PDFs with extractable text, DOCX, Markdown, TXT, and public article links. Organize materials with learning spaces and tags. |
| Reading and questions | Read, select passages, highlight, annotate, and discuss the current document or selected materials with AI. |
| Answers with sources | Follow citations to the original page or section, with a clear indication when the available evidence is insufficient. |
| AI knowledge organization | Generate summaries and classification suggestions automatically, and draft knowledge pages from selected materials for you to review, edit, and accept. |
| Notes and learning continuity | Save excerpts, your own explanations, and unresolved questions, then resume from your last reading position. |
| Cloud saving and management | Save materials and edit history, show sync status, and support conflict recovery, export, and a recycle bin. |

The core learning flow:

**Collect materials → Read and ask → Check the source → Save your understanding → Keep learning**

### Product principles

- **Verifiable sources**: distinguish original materials, user notes, and AI-generated content.
- **User control over organization**: offer AI suggestions, preserve manual edits, and support undo and version recovery.
- **Clear status**: show file saving, parsing, AI readiness, and cloud sync as distinct states.
- **Web first**: support desktop, phone, and iPad browsers through responsive design. Evaluate standalone clients once the core features are stable.

## Documentation and design

The detailed documents linked below are currently in Simplified Chinese.

| Resource | Contents |
| --- | --- |
| [Product requirements](docs/PRD.md) | Use cases, feature rules, data lifecycle, acceptance criteria, and release planning. |
| [Technology and architecture](docs/TECH_STACK.md) | Technical direction, module boundaries, background processing, cloud saving, and validation tasks. |
| [TraeWork Design prompt](docs/TRAE_DESIGN_PROMPT.md) | Page, interaction, component, and state requirements for web, iOS / Android phones, and iPad. |
| [Logo](assets/conuo-logo.png) | The Conuo brand symbol in PNG format. |

The product and technical documentation baseline is **v0.5**; the page design prompt is **v1.0**. Design resources and page prototypes are being refined in the local `conuo-design/` directory, which is excluded by `.gitignore`. Simulated interactions in a prototype do not mean the corresponding product features have been implemented.

## Technology stack

| Layer | Selection |
| --- | --- |
| Web interface | React · Tailwind CSS · TypeScript |
| Application framework and business API | Next.js · TypeScript · Node.js Route Handlers |
| Database and vector search | Supabase PostgreSQL · pgvector |
| Web and business API deployment | Vercel |
| Reading and editing plan | PDF.js · Tiptap |
| Document parsing and asynchronous processing plan | Python · Celery; queue integration and deployment approach require validation |
| Design system | TraeWork |

Supabase has been selected for the database. Authentication, object storage, real-time notifications, and model providers remain undecided. Dependency versions and background task deployment will follow the [technical plan](docs/TECH_STACK.md) and subsequent validation results.

## Directory structure

```text
conuo/
├── .gitignore                       # Excludes the local design directory
├── README.md                        # Simplified Chinese homepage (default)
├── README.en.md                     # English README
├── assets/
│   └── conuo-logo.png               # Logo symbol
└── docs/
    ├── PRD.md                       # Product requirements
    ├── TECH_STACK.md                # Technical plan
    └── TRAE_DESIGN_PROMPT.md         # Page design prompt
```

## Getting to know the project

1. Read the [PRD](docs/PRD.md) for the first release scope and complete learning flow.
2. Read the [technical plan](docs/TECH_STACK.md) for module responsibilities and items that need validation.
3. Use the [page design prompt](docs/TRAE_DESIGN_PROMPT.md) in TraeWork Design, together with the existing theme, components, and brand assets, to develop the page designs.

There is no Next.js application, dependency manifest, or startup script yet. Development prerequisites, configuration, startup commands, and validation steps will be added here when the application is created.

## Roadmap

| Phase | Goal | Current status |
| --- | --- | --- |
| Product and design validation | Refine requirements, key pages, and components; validate parsing, citation navigation, retrieval, and saving and recovery. | Documentation and base design resources are organized; page design is in progress; technical validation is pending |
| M0 · First web release | Complete the flow from importing materials to reading and questions, knowledge organization, notes, and cloud saving. | Development pending |
| M1 · Web improvements | Refine the experience based on trial feedback and progressively validate OCR, more file formats, background organization, and library-wide search. | Planned |
| M2 · Learning enhancements | Explore explaining concepts in your own words, exercises, review, and optional supplemental web research. | Planned |

Standalone phone, iPad, Windows, and macOS clients will be evaluated separately once the core web features and interactions are stable. They have not been scheduled, and their development does not depend on completing every M2 feature. Handwriting, system sharing, and full offline material packages will be validated in the relevant platform phase.

## Collaboration guidelines

- Map feature changes to PRD requirements and acceptance scenarios before updating the relevant designs or technical plan.
- Use consistent TraeWork components and Conuo brand assets, including loading, empty, failure, and recovery states.
- Distinguish implemented capabilities, design proposals, and unresolved decisions in implementation and validation records.

## License

A project license has not yet been selected, and this directory does not contain a `LICENSE` file. Use of the design system and icon resources is governed by their original licenses.
