<p align="center"><img src="assets/conuo-logo.png" width="120" height="120" alt="Conuo logo" /></p>
<h1 align="center">Conuo</h1>
<p align="center"><strong>A companion for learning from your own sources.</strong></p>
<p align="center">An AI learning workspace built around your personal library</p>
<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>

Conuo organizes files, web pages, and notes into a searchable personal knowledge base with traceable sources. Ask while reading, verify the original evidence, save your understanding, and continue from where you left off.

**Collect → Read and ask → Verify sources → Save understanding → Continue learning**

## Current status

The web app is deployed to isolated [staging](https://conuo-staging.vercel.app), with production release checks still in progress. The main natural Cron checks passed. The project owner confirmed physical two-device sync and the real same-browser password-recovery flow. Cleanup resilience, cross-browser email links, disaster recovery, and other remaining gates are tracked in the [deployment record](docs/STAGING_DEPLOYMENT.md) and [production runbook](docs/PRODUCTION_RELEASE.md). The original production environment has not been upgraded.

Windows/macOS and iOS/iPadOS are in local design and development. **They are not signed or published, and Apple-device acceptance is not complete.** The new native Bearer API support has not been deployed, so the existing staging deployment is not yet evidence of a working native end-to-end flow. Expo Web preview displays labeled demo content only; it does not support real sign-in or replace native testing.

| Platform        | Approach and current scope                                                                                                      | Later stages                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Web             | Next.js + React; existing cloud learning workspace under active improvement                                                     | Independent cloud release gates                                                                |
| Windows / macOS | Electron D0 secure host; D1 reuses and validates the complete web app in the desktop host                                       | D2 local database, file cache, and offline/cloud coexistence; D3 browsing and distribution     |
| iOS             | Expo SDK 57 + React Native 0.86; sign-in, cloud source/knowledge reading, single-source JSON Q&A, and text notes in development | Only part of I1 is being started; sharing, full reading, and release follow the platform PRD   |
| iPadOS          | Shared iOS project with adaptive tablet layouts                                                                                 | P1 cloud reading workspace; Pencil, multiple windows, sharing, and deeper reading belong to P2 |
| Android         | Long-term target                                                                                                                | Outside this native development increment                                                      |

The web app and initial clients use the cloud as the authoritative data store. Browser edits and pending originals stay in session memory; secure native credential storage is not a local library. Local/cloud coexistence belongs to desktop D2. No complete offline workspace is currently provided. See the [web storage policy](docs/WEB_CLOUD_STORAGE.md) and platform PRDs.

## Web feature overview

| Capability             | Existing features                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Sources and knowledge  | Learning spaces, library shelves, tags, filters, ordinary search, and trash; original sources remain distinct from AI knowledge pages |
| Files and web pages    | PDF, DOCX, Markdown, TXT, and public-page imports; originals and versions retained; backup restoration and export                     |
| Reading                | Single-page/continuous PDF views, text reading, annotations, source citations, and cloud reading positions                            |
| Source-grounded Q&A    | Explicit source scopes, Markdown and formula rendering, original citations, and per-source AI permission                              |
| Region study           | Send a selected PDF region for explanation, questions, or one-off exercises; no OCR prerequisite or full-document index               |
| Knowledge organization | Summaries, tags, topic drafts, page updates, and relationships; review before saving, with provenance and history                     |
| Notes and continuation | Rich-text notes, excerpts, conversation records, continuation, and unresolved questions                                               |
| Accounts and saving    | Supabase Auth, private Storage, cloud revision conflicts, source deletion, and account closure                                        |

A saved state requires cloud acknowledgment. Connectivity loss does not create an anonymous or local workspace. AI output does not silently replace sources. Native coverage is tracked separately and must not be inferred from this web feature table.

## Quick start

Requires **Node.js 24+** and npm. From the repository root:

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Follow [cloud setup](docs/CLOUD_SETUP.md) using the [web environment example](apps/web/.env.example), then sign in. Missing configuration or authentication does not create an anonymous workspace. Development/build scripts prepare the PDF worker and logo.

Public configuration may contain the project URL and publishable/anon key only. Model credentials and privileged Supabase keys remain on the server and must not enter client bundles or Git. See [model setup](docs/MODEL_SETUP.md).

## Development commands

| Command                                              | Purpose                                         |
| ---------------------------------------------------- | ----------------------------------------------- |
| `npm run dev`                                        | Web development server                          |
| `npm run build` / `npm start`                        | Build / run the web production build            |
| `npm run typecheck` / `npm run lint` / `npm test`    | Web type, static, and test checks               |
| `npm run desktop:dev`                                | Electron development host                       |
| `npm run desktop:build`                              | Local desktop build; not signing or publication |
| `npm run mobile:dev`                                 | Expo native development entry                   |
| `npm run mobile:preview`                             | Mobile/tablet web demo preview                  |
| `npm run clients:typecheck` / `npm run clients:test` | Client type and test checks                     |

Client test evidence and platform build limitations are recorded in [client implementation](docs/CLIENT_IMPLEMENTATION.md); Web cloud acceptance is recorded in [implementation status](docs/IMPLEMENTATION_STATUS.md). Migration tests use PGlite and do not require installing or starting local PostgreSQL. Apple system builds and physical-device acceptance require the corresponding environment; browser previews do not replace them.

## Technology and structure

Next.js, React, TypeScript, and Tailwind CSS power the web app and shared API. PDF.js and Tiptap support existing reading and editing. Supabase provides Auth, PostgreSQL, private Storage, and pgvector; Vercel hosts the web app/API. The bounded Python indexing CLI and cloud schedulers have separate deployment boundaries. See the [technical plan](docs/TECH_STACK.md).

```text
conuo/
├── apps/web/          # Web app, shared API, and tests
├── apps/desktop/      # Electron desktop host
├── apps/mobile/       # Expo iOS / iPadOS project with distinct layouts
├── apps/processor/    # Bounded Python indexing CLI
├── supabase/          # Migrations and isolation checks
├── docs/              # Shared/platform PRDs, feature guides, release evidence
├── assets/            # Brand assets
├── README.md          # Default Simplified Chinese entry
└── README.en.md       # English
```

Local `conuo-design/` assets are retained and ignored by Git; they are not runtime dependencies. The old page-generation prompt is retired. The shared/platform PRDs and [UI guide](docs/UI_STYLE_GUIDE.md) are the current design references.

## Documentation

- Product: [Shared PRD](docs/PRD.md) · [Windows/macOS](docs/DESKTOP_PRD.md) · [iOS](docs/IOS_PRD.md) · [iPadOS](docs/IPADOS_PRD.md)
- Development: [Technical plan](docs/TECH_STACK.md) · [UI guide](docs/UI_STYLE_GUIDE.md) · [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- Cloud: [Setup](docs/CLOUD_SETUP.md) · [Acceptance](docs/CLOUD_E2E_ACCEPTANCE.md) · [Deployment](docs/STAGING_DEPLOYMENT.md) · [Production release](docs/PRODUCTION_RELEASE.md) · [Disaster recovery](docs/DISASTER_RECOVERY.md)
- Features: [File versions](docs/FILE_VERSIONS.md) · [Region study](docs/REGION_STUDY.md) · [Streaming answers](docs/STREAMING_ANSWERS.md) · [Search](docs/SEARCH_INDEXING.md) · [Organization](docs/ORGANIZATION.md) · [Backup restoration](docs/BACKUP_RESTORE.md) · [Export](docs/EXPORT_FORMAT.md)

Track requirements, implementation, local checks, cloud/device acceptance, signing, and publication separately. Detailed product documents are currently maintained in Simplified Chinese.

## License

A project license has not been selected, and the repository has no `LICENSE` file. Third-party components and assets retain their respective licenses.
