<p align="center">
  <img src="assets/conuo-logo.png" width="120" height="120" alt="Conuo logo: companion pages forming the letter C" />
</p>

<h1 align="center">Conuo · 可诺</h1>

<p align="center"><strong>Learn it, together.</strong></p>
<p align="center">An AI learning companion centered on your personal library</p>
<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>

<p align="center">
  <a href="docs/PRD.md">Product requirements</a> ·
  <a href="docs/IMPLEMENTATION_STATUS.md">Implementation status</a> ·
  <a href="docs/CLOUD_E2E_ACCEPTANCE.md">Cloud acceptance</a> ·
  <a href="docs/CLOUD_SETUP.md">Cloud setup</a> ·
  <a href="docs/REGION_STUDY.md">Region study</a> ·
  <a href="docs/TRAE_DESIGN_PROMPT.md">Page design</a>
</p>

---

Conuo aims to organize files, web pages, and notes into a searchable personal knowledge base with traceable sources. Ask questions while reading, check the original material, save your own understanding, and pick up where you left off.

**The web app requires sign-in and uses cloud storage as its sole durable workspace.** Workspace data, notes, reading positions, and accepted knowledge updates live in Supabase PostgreSQL; originals live in private Storage. The page stages edits and upload bytes in memory and reloads from the cloud after refresh. Local and cloud workspaces will coexist only in the future desktop app. See [Web storage policy](docs/WEB_CLOUD_STORAGE.md).

> **Status: the first web release is in development, with a runnable cloud workspace.** It supports material and web imports, historical reading, notes, reviewed knowledge organization, and exports with a reviewed knowledge-base scope. Ordinary search, question-to-source discovery, normalized source indexes, optional pgvector hybrid retrieval, and a bounded Python indexing processor are connected. Supabase PRODUCTION has 19 applied and checked migrations, including the restricted historical-version cleanup RPCs. A real account has completed sign-in, a cloud TXT upload, recovery in a second browser, and an original download whose SHA-256 matches the acceptance fixture. `20260914000800_fast_workspace_saves.sql`, `20260914120601_upload_intents.sql`, `20260914120700_organization_jobs.sql`, `20260915045450_annotation_utf16_text_anchors.sql`, and `20260915060323_source_purge_saved_content_selection.sql` are five locally prepared migrations; none has been applied to PRODUCTION and all require user authorization before they can run. They add save-path improvements, original-upload reservations and cleanup, durable organization jobs, exact annotation positions, and explicit cleanup choices for related saved content. Signed-in source Q&A and PDF region study have passed live model and request-ledger checks. Real two-account isolation, the full two-device concurrent CAS matrix, and cloud scheduling still need acceptance testing. Full M0 is unfinished and the app is not deployed. Without a configured model, source excerpts remain available; cloud Q&A supports generated answers with source citations. The Web App Manifest now provides an install name, icons, and shortcuts; compatible browsers can add it to a desktop or home screen after an HTTPS deployment, but it is not an offline package.

The PDF reader now supports fixed-region visual study on the current page: an image-capable multimodal model can directly explain the screenshot, answer a region-specific question, or generate a one-off exercise. Explanations have a summary and separate observation, reasoning, and takeaway sections; explanation text, Q&A, and exercises render Markdown and math. A screenshot is transmitted only after an explicit send action, remains non-persistent by default, and the result is bound to the source, version, physical page, and normalized rectangle. The flow does not depend on OCR or create a full-text index; scanned-PDF body text is still not searchable. The configured DeepSeek `deepseek-flash` adapter has passed a live screenshot-input smoke test; signed-in explanation, image Q&A, and Chinese exercise generation have now passed live request-ledger checks. See [Region study](docs/REGION_STUDY.md).

**Collect materials → Read and ask → Check the source → Save your understanding → Keep learning**

PDF reading offers single-page and continuous-scroll modes, retaining the available position within a page when switching. Progress follows physical pages, with nearby pages rendered on demand. Phones keep the mode control above the reading area; tablets and wide screens use the reading tools. See [PDF reading modes](docs/PDF_READING_MODES.md).

After a confirmed account-deletion request, the web app stops that account's tasks and access, clears its temporary page state, and keeps a session fence. After refresh, cloud identity and deletion gates are checked again. Legacy IndexedDB copies are not active workspaces and are not cleaned automatically. Cloud Auth/Storage deletion and real cross-device acceptance remain pending. See [Originals and legacy caches](docs/LOCAL_ORIGINALS.md).

Applied AI knowledge-page updates can be withdrawn after comparing the original, applied, and current content. Proven independent edits are retained; overlapping edits or repeated positions require an explicit choice or a plain-text merge. Confirmation creates a history version and seals the whole job, including when every change is kept; web actions wait for cloud acknowledgment. Unapplied review selections and edits remain in page memory and are lost on refresh. See [Safe knowledge-update withdrawal](docs/KNOWLEDGE_UPDATE_WITHDRAWAL.md).

## Quick start

Use **Node.js 24+** and npm. From the repository root:

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Configure Supabase, then register or sign in to use the workspace. Missing configuration shows setup guidance; signed-out visitors see the account entry instead of an anonymous workspace. Demo materials are added only when you explicitly choose them.

Development and build scripts prepare the PDF worker and application logo automatically. Press `Ctrl+C` in the running terminal to stop the development server.

Follow [Cloud setup](docs/CLOUD_SETUP.md) to configure `apps/web/.env.local`, database migrations, and Auth callbacks. Start with [apps/web/.env.example](apps/web/.env.example). Public `NEXT_PUBLIC_*` variables may contain the project URL and publishable/anon key only, never privileged server keys. Optional generation uses server-only model credentials and a Supabase request-ledger key; see [Model setup](docs/MODEL_SETUP.md). Do not commit real configuration or send credentials in chat.

## What works today

| Capability                       | Current implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Materials and collections        | Create learning spaces, browse book-style collection covers, edit tags and space associations, search, and restore items from the recycle bin. Sort materials by latest update, latest addition, or name; list rows show update time and the URL restores the order. The first-material path names a collection first and preselects it as the import destination.                                                                                                                                                    |
| File import                      | PDF, DOCX, Markdown, and TXT; retain originals, content hashes, source version identifiers, and text chunks. Reuse identical content or keep a separate copy. New materials start with AI use disabled and require an explicit import opt-in; unapproved materials can still be parsed, read, and found by ordinary search. The browser prechecks per-file and batch conditions, then checks retained-original allowance after hashing and before saving.                                                             |
| File replacement and history     | Preview and explicitly save a new version, including switches between these formats. Keep the library title, tags, collections, permissions, and each original; earlier citations open the exact read-only version. A retained version can be promoted back to current, or—after a server-derived impact preview and explicit confirmation—cleaned individually without replacing historical citations. See [File versions](docs/FILE_VERSIONS.md).                                                                   |
| Web collections                  | Preview public articles and save text, a selection, or a link. Support manual paste, confirmed refresh and historical reading, preserving URLs, capture times and earlier citations. New webpages also start with AI use disabled; the explicit import opt-in applies to both files and webpages. See [Web import](docs/WEB_IMPORT.md).                                                                                                                                                                               |
| Reading                          | Original PDF pages, pagination, zoom, text selection, and highlights; text reading, original downloads, and saved reading positions. The current PDF page supports a fixed region selection; scanned PDFs can be retained, but their body text still receives no OCR.                                                                                                                                                                                                                                                 |
| Region visual study              | After an explicit send, a model with image support can explain a PDF region, answer a region-specific question, or generate a one-off exercise. The screenshot is temporary and non-persistent by default; results bind to the source, version, physical page, and normalized rectangle and do not enter full-text or library-wide indexes. See [Region study](docs/REGION_STUDY.md).                                                                                                                                 |
| Web install entry                | Provides a Web App Manifest, 180/192/512 brand icons, library and Q&A shortcuts, and standalone-window metadata for iOS/iPadOS. Settings show a direct browser prompt, Safari home-screen guidance, or installed state when applicable; when served over HTTPS, compatible browsers can add the app to a desktop or home screen, without an offline package or service worker.                                                                                                                                        |
| Evidence and citations           | Search a selection, current document, selected sources, or current space. Results are labeled as source excerpts and preserve document, version, page, or section references.                                                                                                                                                                                                                                                                                                                                         |
| Keyword and semantic search      | The material toolbar supports keyword and question search with shared type, tag, and date filters. Question mode shows verifiable source excerpts and can prefill the bounded question flow with 1–5 selected sources, but never sends automatically. See [Search and indexing](docs/SEARCH_INDEXING.md).                                                                                                                                                                                                             |
| Generative integration           | Server-side model adapter, citation/region checks, and request ledger. Web answers stream previews and save only after final confirmation. The local DeepSeek `deepseek-flash` adapter has passed a live multimodal screenshot-input smoke test; vision still requires `CONUO_MODEL_VISION_ENABLED=true`. The existing server-side ledger key is configured in the ignored local environment file, and live source Q&A and region-study checks have passed. See [Model setup](docs/MODEL_SETUP.md).                   |
| Organization and topic drafts    | Single-source summaries, tag and topic suggestions; choose 1–10 sources to generate up to 3 topic drafts for individual acceptance, editing, or dismissal. Tags require explicit selection and support locking and guarded undo; see [Organization](docs/ORGANIZATION.md).                                                                                                                                                                                                                                            |
| Knowledge updates and withdrawal | Accept or ignore up to 12 source-backed changes; preview original, applied, and current content before withdrawing an applied job. Retain independent edits and resolve conflicts through an explicit choice or plain-text merge. Confirmation saves history and seals the whole job; web actions wait for cloud acknowledgment. See [Safe withdrawal](docs/KNOWLEDGE_UPDATE_WITHDRAWAL.md).                                                                                                                          |
| Notes                            | Tiptap editing, saved excerpts and responses, knowledge-page drafts, and note version recovery, with source citations retained.                                                                                                                                                                                                                                                                                                                                                                                       |
| Knowledge-page library           | Browse knowledge pages grouped by collection, with distinct AI draft, manual draft, and saved states. Cards show summaries, associated-source counts, and update times. Status filters and title, body, or source search are restored from the URL.                                                                                                                                                                                                                                                                   |
| Cloud data and export            | PostgreSQL stores account workspaces and private Storage stores originals. Review and export the full workspace or one knowledge base; external cited sources and their annotations are explicitly listed. ZIP exports include every included current and retained source version's original, text, and citation mappings, plus notes, conversations, and annotations. Notes, knowledge pages, and their history include Markdown, safe HTML, and exact original content; see [Export format](docs/EXPORT_FORMAT.md). |
| Permanent source deletion        | Confirm a server-derived impact preview to delete all source versions. Saved notes, knowledge pages, and conversations remain by default. Explicit whole-document/history and whole-conversation choices plus tombstones are implemented locally and require the new migration. See [Permanent deletion](docs/PERMANENT_DELETION.md).                                                                                                                                                                                 |
| Restore from backup              | Preview a Conuo ZIP and restore new copies with history and citations. Originals are verified and missing files require acknowledgment; restored sources start with AI disabled. Signed-in restoration waits for cloud acknowledgment. See [Backup restoration](docs/BACKUP_RESTORE.md).                                                                                                                                                                                                                              |

The web app shows a saved state only after cloud acknowledgment; edits in page memory are not saved data. An initial cloud-read failure keeps the workspace unavailable and never creates an empty replacement or starts an overwrite. Failed saves remain retryable; leaving or signing out protects unsaved changes without a “keep a local draft and exit” option. Cloud search requires a signed-in account and confirmed save. **New AI answers still use original sources only**; ordinary search includes notes and accepted knowledge pages, excluding drafts by default.

Filter ordinary search by notes or knowledge pages and creation time before typing; an empty query browses the selected type. The URL restores type and date filters, and turning AI off keeps readable results visible. Source tags and favorites do not apply to notes or knowledge pages. Bulk tags show per-source results after cloud acknowledgment and retry failed items only; see [Bulk tags](docs/BULK_TAGS.md).

Bulk space association and recycling also wait for cloud acknowledgment before showing per-source success, no change, or failure. A failed save can persist the latest snapshot while retaining the first successful items; continued review includes only sources newly associated by this operation. See [Bulk source actions](docs/BULK_SOURCE_ACTIONS.md).

Live source analysis returned a summary, 8 tag suggestions, and 5 topic suggestions. Two sources generated 3 knowledge topics; an accepted page and its citations were saved to the cloud and restored after refresh. This currently uses manual page execution available only in development; leaving the page stops the request. Automatic analysis is off, and the production durable organization queue, processor, and scheduler are not deployed. See [Cloud acceptance](docs/CLOUD_E2E_ACCEPTANCE.md). Separate vector jobs persist in the database with leases, checkpoints, cancellation, and retries. The [Python processor](apps/processor/README.md) must be run explicitly and defaults to at most 5 jobs and 40 seconds. Suggestions require human review before application.

## Technology stack

Settings show AI request counts, UTC reset rules, and local times. Missing server-side ledger configuration is shown as unknown, never a fabricated zero balance. Official originals are read from private Storage under the current account's permissions; imports and restoration stage bytes only in memory. Legacy anonymous materials are read only after an explicit import request, then validated and restored as new copies in the current cloud account. The old copies and originals remain intact. See [Model setup](docs/MODEL_SETUP.md) and [Originals and legacy caches](docs/LOCAL_ORIGINALS.md).

| Layer                    | Selection and status                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web and API              | Next.js 16 · React 19 · TypeScript; App Router and `/api/v1/` Route Handlers                                                                                                                                                                                                                                                                                                                |
| Styling                  | Tailwind CSS 4 and component CSS; book-style collection browsing and a reader based on the TraeWork prototype                                                                                                                                                                                                                                                                               |
| Reading and editing      | PDF.js · Tiptap; Mammoth for DOCX text extraction; PDF region captures are created in the browser and sent to a multimodal model only through an explicit action                                                                                                                                                                                                                            |
| Session staging          | Memory snapshots and pending upload bytes; browser-based text chunking and keyword retrieval                                                                                                                                                                                                                                                                                                |
| Cloud identity and files | Supabase Auth + Storage; PRODUCTION has verified login settings, private-bucket policies, and 19 applied migrations. A real one-account TXT upload, second-browser recovery, and original download have passed with a fixture-matching SHA-256. Two-account isolation and the full two-device concurrent CAS matrix remain; the fast-save migration is local only and has not been applied. |
| Database                 | Supabase PostgreSQL; atomic source, immutable-version, and chunk projection, with the 3 MiB JSONB workspace retained as the compatibility save protocol                                                                                                                                                                                                                                     |
| Model integration        | Server-side Chat Completions adapter; local DeepSeek `deepseek-flash` has passed a live PNG multimodal request. The request ledger is implemented; the existing ledger key is configured locally and signed-in source Q&A and region study have passed live checks; deployment remains pending.                                                                                             |
| Retrieval and jobs       | pgvector, a durable indexing queue, and a bounded Python 3.12 CLI; tested with real SQL and local HTTP, with provider and cloud scheduling validation pending                                                                                                                                                                                                                               |
| Deployment target        | Vercel, with `apps/web` as the project root; not deployed                                                                                                                                                                                                                                                                                                                                   |

Exact versions are recorded in [apps/web/package.json](apps/web/package.json) and the lockfile. See the [technical plan](docs/TECH_STACK.md) for the target architecture.

## Development commands

Run these commands from the repository root:

| Command             | Purpose                                  |
| ------------------- | ---------------------------------------- |
| `npm run dev`       | Start the local web development server   |
| `npm run typecheck` | Check TypeScript types                   |
| `npm run lint`      | Run ESLint                               |
| `npm run test`      | Run Vitest tests                         |
| `npm run build`     | Create a Next.js production build        |
| `npm start`         | Run an existing production build locally |

Local tests cover imports, citations, retrieval scope isolation, persistence races, exports, and API boundaries, and execute real migrations with PGlite + pgvector. Python test commands are in the [processor guide](apps/processor/README.md). These results do not establish real Supabase concurrency, email authentication, or cross-device synchronization. See [Implementation status](docs/IMPLEMENTATION_STATUS.md) for the verification record.

## Repository structure

```text
conuo/
├── apps/web/
│   ├── src/app/                     # Pages, Auth callbacks, business API
│   ├── src/components/              # Collections, reader, notes, accounts
│   ├── src/lib/                     # Import, retrieval, persistence, cloud, tests
│   ├── scripts/prepare-assets.mjs   # Prepare the PDF worker and logo
│   ├── .env.example                 # Public connection and optional server variables
│   └── package.json
├── apps/processor/                 # Bounded Python vector processor and local tests
├── supabase/
│   ├── migrations/                 # Database and private Storage migration
│   └── tests/                      # RLS checks for an isolated database
├── assets/conuo-logo.png
├── docs/
│   ├── PRD.md
│   ├── TECH_STACK.md
│   ├── TRAE_DESIGN_PROMPT.md
│   ├── CLOUD_SETUP.md
│   ├── WEB_CLOUD_STORAGE.md
│   ├── MODEL_SETUP.md
│   ├── REGION_STUDY.md
│   ├── SEARCH_INDEXING.md
│   ├── ORGANIZATION.md
│   ├── KNOWLEDGE_UPDATE_WITHDRAWAL.md
│   ├── FILE_VERSIONS.md
│   ├── EXPORT_FORMAT.md
│   └── IMPLEMENTATION_STATUS.md
├── README.md
├── README.en.md
├── package.json                    # npm workspace and root scripts
└── package-lock.json
```

Design resources and prototypes live in the local `conuo-design/` directory, which is excluded by `.gitignore` and is not a runtime dependency. Local environment files, dependencies, build output, and test artifacts are also excluded from Git.

## Roadmap and boundaries

- **M0 · Web in development**: knowledge review, typed relationships, file and web version chains, ordinary search, and source indexing are implemented. Continue evaluating real retrieval and model quality, deploy and validate scheduling, and complete the data model and lifecycle.
- **Later web releases**: assess library-wide OCR, more file formats, background knowledge organization, and complete exercise-attempt and review flows. A one-off exercise from a PDF region does not mean those systems are complete.
- **Other platforms**: development currently targets responsive web only. Standalone phone, iPad, Windows, and macOS clients will be evaluated after the core web experience stabilizes and have not been scheduled; local and cloud coexistence in desktop clients requires separate design and acceptance.

Permanent-source deletion and account deletion have protocols and protected server-side execution paths: [the former](docs/PERMANENT_DELETION.md) retains saved content by default and locally prepared code adds whole-note/knowledge-page choices including all history and whole-conversation cleanup, while its migration remains pending. Account deletion requires an impact preview plus email/password/`DELETE` confirmation and uses a Storage/Auth two-stage outbox. Real one-account Storage upload, recovery, and download are verified; two-account Storage isolation, Auth Admin, Cron, and full two-device concurrency still need integration validation. Historical browser-cache deletion tests do not define the current web storage mode. Full M0 acceptance and server disaster recovery remain unfinished. Personal ZIP backups restore as new cloud copies; see [Backup restoration](docs/BACKUP_RESTORE.md). Organization records are limited to 1,000 jobs and share the 3 MiB workspace snapshot limit with other content. Settings can preview and remove dismissed, failed, and cancelled terminal records; active jobs and pending reviews remain. The [PRD](docs/PRD.md) defines the intended scope; [Implementation status](docs/IMPLEMENTATION_STATUS.md) records actual progress.

File imports and replacements are limited to 30 MiB each and 20 files / 150 MiB per browser batch. Admission still estimates a conservative 512 MiB retained-original limit from the current account snapshot; this is neither local-storage capacity nor a cloud-plan commitment. Exact Storage quota and upload reservations require the pending migration 21. Imports recheck duplicates and capacity in page memory, then upload originals and commit the cloud revision CAS through the save queue. Initial loads, refreshes, and cross-page reloads use the cloud; tabs do not exchange workspaces through shared IndexedDB. Cloud conflicts preserve current-page edits for an explicit decision without automatic merging or a local draft that survives refresh. Each source retains at most 200 historical versions, and all text and chunks share the 3 MiB snapshot limit without automatic trimming. After an impact confirmation, a retained version can become current; a signed-in, saved workspace can also clean one historical version after server preview and explicit confirmation. Earlier citations are not substituted. Parsing runs in the browser. Live one-account originals, source Q&A, and region study have passed checks; two-account isolation and the complete two-device concurrent matrix remain pending.

## Documentation and collaboration

[Requirements](docs/PRD.md) · [Technical plan](docs/TECH_STACK.md) · [Page design](docs/TRAE_DESIGN_PROMPT.md) · [Cloud setup](docs/CLOUD_SETUP.md) · [Web storage policy](docs/WEB_CLOUD_STORAGE.md) · [Cloud acceptance](docs/CLOUD_E2E_ACCEPTANCE.md) · [Model setup](docs/MODEL_SETUP.md) · [Region study](docs/REGION_STUDY.md) · [Streaming answers](docs/STREAMING_ANSWERS.md) · [Search and indexing](docs/SEARCH_INDEXING.md) · [Organization](docs/ORGANIZATION.md) · [Safe knowledge-update withdrawal](docs/KNOWLEDGE_UPDATE_WITHDRAWAL.md) · [File versions](docs/FILE_VERSIONS.md) · [Permanent deletion](docs/PERMANENT_DELETION.md) · [Export format](docs/EXPORT_FORMAT.md) · [Implementation status](docs/IMPLEMENTATION_STATUS.md) · [Logo](assets/conuo-logo.png)

Detailed project documents are currently in Simplified Chinese. Map feature changes to requirements and acceptance scenarios, retain provenance and manual edits, and make recovery possible. The collection view follows the latest book-cover layout; the reader retains the original reading-and-questions split view. Distinguish written code, local verification, and real cloud validation in progress records.

## License

A project license has not been selected, and the repository does not contain a `LICENSE` file. Design-system and icon resources remain subject to their original licenses.
