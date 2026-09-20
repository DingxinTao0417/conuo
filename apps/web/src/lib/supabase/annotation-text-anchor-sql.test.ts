import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Source, SourceKind, WorkspaceData } from "../types";

// Execute the original migration chain on ephemeral PostgreSQL. This is not
// PostgREST, real Storage, or a multi-connection concurrency verification.
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = "2026-09-14T12:00:00.000Z";
const migrationName = "20260915045450_annotation_utf16_text_anchors.sql";
const migrations = new URL("../../../../../supabase/migrations/", import.meta.url);
const sourceText = "# 起点\n\n😀学习 **梯度下降**。\n\n😀学习 **梯度下降**。\n";
const quote = "学习 **梯度下降**。";

type TestAnnotation = Record<string, unknown>;
type TestWorkspace = Omit<WorkspaceData, "annotations" | "recoverableDrafts"> & {
  annotations: TestAnnotation[];
  recoverableDrafts?: TestAnnotation[];
};
type Role = "anon" | "authenticated" | "service_role";
type ProjectedAnnotation = {
  owner_id: string;
  annotation_id: string;
  source_id: string;
  version_id: string;
  quote: string;
  note: string;
  text_anchor: { start: number; end: number } | null;
};

let db: PGlite;
let backfilled: ProjectedAnnotation;

function source(versionId = "v1", text = sourceText, kind: SourceKind = "markdown"): Source {
  return {
    id: "source-a",
    versionId,
    title: "Anchored source",
    filename: `anchor.${kind === "markdown" ? "md" : kind === "text" ? "txt" : kind === "web" ? "html" : kind}`,
    kind,
    mime: "text/plain",
    size: 256,
    hash: `hash-${versionId}`,
    spaceIds: ["library"],
    tags: [],
    status: "ready",
    text,
    chunks: [
      {
        id: `chunk-${versionId}`,
        sourceId: "source-a",
        versionId,
        text,
        section: "正文",
        order: 0,
      },
    ],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
  };
}

function annotation(text = sourceText, rawQuote = quote, anchored = true): TestAnnotation {
  const start = text.lastIndexOf(rawQuote);
  return {
    id: "annotation-a",
    sourceId: "source-a",
    versionId: "v1",
    quote: rawQuote,
    note: "用户理解",
    createdAt: now,
    ...(anchored ? { textAnchor: { start, end: start + rawQuote.length } } : {}),
  };
}

function workspace(item = source(), a = annotation(item.text)): TestWorkspace {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "library", name: "Library", goal: "", color: "blue", archived: false, createdAt: now },
    ],
    sources: [item],
    notes: [],
    annotations: [a],
    conversations: [],
    aiEnabled: true,
  };
}

async function asRole<T>(role: Role, owner: string | null, action: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner ?? ""]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await action();
  } finally {
    await db.exec("RESET ROLE");
  }
}

async function save(data: unknown, revision = 0, owner = ownerA) {
  return asRole("authenticated", owner, async () => {
    const result = await db.query<{ revision: number }>(
      "select public.save_workspace($1::jsonb,$2::bigint) as revision",
      [JSON.stringify(data), revision],
    );
    return result.rows[0]!.revision;
  });
}

function recoveryWorkspace(anchored = true): TestWorkspace {
  const item = source();
  item.deletedAt = now;
  const a = annotation(item.text, quote, anchored);
  const data = workspace(item, a);
  data.recoverableDrafts = [
    {
      id: `deleted-source-annotation-a-${Date.parse(now).toString(36)}`,
      kind: "source-annotation",
      reason: "source-deleted-during-offline-edit",
      sourceId: a.sourceId,
      sourceVersionId: a.versionId,
      sourceTitle: item.title,
      sourceDeletedAt: now,
      annotationId: a.id,
      annotationCreatedAt: a.createdAt,
      quote: a.quote,
      note: a.note,
      capturedAt: now,
      ...(anchored ? { textAnchor: structuredClone(a.textAnchor) } : {}),
    },
  ];
  return data;
}

async function projected(owner = ownerA) {
  return (
    await db.query<ProjectedAnnotation>(
      "select * from public.annotations where owner_id=$1::uuid",
      [owner],
    )
  ).rows;
}

async function saved(owner = ownerA) {
  const result = await db.query<{ data: TestWorkspace; revision: number }>(
    "select data,revision from public.workspaces where owner_id=$1::uuid",
    [owner],
  );
  return result.rows[0];
}

beforeAll(async () => {
  db = await PGlite.create("memory://", { extensions: { vector } });
  try {
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      INSERT INTO auth.users VALUES ('${ownerA}'),('${ownerB}');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb not null default '{}'::jsonb);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1,'/') $$;
      GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;
      GRANT SELECT,INSERT,DELETE ON storage.objects TO authenticated;
    `);
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
      if (name === migrationName) continue;
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
    }
    // The old projector accepts the optional JSON field but has no text_anchor
    // column. Upgrade must backfill it without treating it as a new identity.
    await save(workspace());
    await db.exec(await readFile(new URL(migrationName, migrations), "utf8"));
    backfilled = (await projected())[0]!;
  } catch (error) {
    await db.close();
    throw error;
  }
}, 30_000);

beforeEach(async () => {
  await db.exec(
    "RESET ROLE; TRUNCATE public.workspaces CASCADE; TRUNCATE public.account_deletions CASCADE; SET TIME ZONE 'UTC';",
  );
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("projected annotation UTF-16 source-text anchors", () => {
  it("backfills an anchored authoritative snapshot accepted by the older projector", () => {
    expect(backfilled).toMatchObject({
      owner_id: ownerA,
      annotation_id: "annotation-a",
      quote,
      text_anchor: annotation().textAnchor,
    });
  });

  it.each(["markdown", "text", "docx", "pdf", "web"] as const)(
    "proves exact anchored raw text for %s without a format restriction",
    async (kind) => {
      const item = source("v1", sourceText, kind);
      expect(await save(workspace(item))).toBe(1);
      expect((await projected())[0]).toMatchObject({ quote, text_anchor: annotation().textAnchor });
    },
  );

  it("keeps the second repeated raw occurrence instead of guessing the first", async () => {
    const data = workspace();
    await save(data);
    const row = (await projected())[0]!;
    expect(row.text_anchor!.start).toBe(sourceText.lastIndexOf(quote));
    expect(row.text_anchor!.start).toBeGreaterThan(sourceText.indexOf(quote));
  });

  it("uses the anchored historical version, not the current version's same phrase", async () => {
    const old = source();
    const current = source("v2", "新版内容。学习 **梯度下降**。", "text");
    current.versions = [{ ...old, archivedAt: now }];
    await save(workspace(current, annotation(old.text)));
    expect((await projected())[0]).toMatchObject({
      version_id: "v1",
      text_anchor: annotation().textAnchor,
    });
  });

  it("preserves anchored annotations on retained recycled source versions", async () => {
    const item = source();
    item.deletedAt = now;
    await save(workspace(item));
    expect((await projected())[0]).toMatchObject({ quote, text_anchor: annotation().textAnchor });
  });

  it("allows note edits while preserving the immutable source identity and anchor", async () => {
    const data = workspace();
    await save(data);
    data.annotations[0]!.note = "新的用户理解";
    expect(await save(data, 1)).toBe(2);
    expect((await projected())[0]).toMatchObject({
      note: "新的用户理解",
      text_anchor: annotation().textAnchor,
    });
  });

  it("retains old unanchored snapshots, even when the source no longer exists", async () => {
    const data = workspace(source(), annotation(sourceText, quote, false));
    data.sources = [];
    await save(data);
    expect((await projected())[0]).toMatchObject({ quote, text_anchor: null });
    data.annotations[0]!.note = "继续编辑旧批注";
    expect(await save(data, 1)).toBe(2);
  });

  it("rejects adding an anchor to an existing unanchored annotation identity", async () => {
    const data = workspace(source(), annotation(sourceText, quote, false));
    await save(data);
    data.annotations[0]!.textAnchor = annotation().textAnchor;
    await expect(save(data, 1)).rejects.toMatchObject({ code: "PT409" });
    expect((await projected())[0]!.text_anchor).toBeNull();
    expect((await saved())!.revision).toBe(1);
  });

  it.each(["remove", "move"] as const)(
    "rejects immutable anchor %s without losing the confirmed snapshot",
    async (operation) => {
      const data = workspace();
      await save(data);
      if (operation === "remove") delete data.annotations[0]!.textAnchor;
      else {
        const start = sourceText.indexOf(quote);
        data.annotations[0]!.textAnchor = { start, end: start + quote.length };
      }
      await expect(save(data, 1)).rejects.toMatchObject({ code: "PT409" });
      expect((await projected())[0]!.text_anchor).toEqual(annotation().textAnchor);
      expect((await saved())!.revision).toBe(1);
    },
  );

  it.each([
    null,
    [],
    {},
    { start: 0 },
    { end: 1 },
    { start: "0", end: 1 },
    { start: 0, end: "1" },
    { start: -1, end: 1 },
    { start: 0.5, end: 1 },
    { start: 0, end: 1.5 },
    { start: 0, end: 0 },
    { start: 2, end: 1 },
    { start: 0, end: 9007199254740992 },
    { start: 0, end: sourceText.length + 1 },
    { start: 0, end: 1, extra: true },
  ])("rejects invalid or incomplete anchor %j atomically", async (textAnchor) => {
    const data = workspace();
    data.annotations[0]!.textAnchor = textAnchor;
    await expect(save(data)).rejects.toMatchObject({ code: "22023" });
    expect(await saved()).toBeUndefined();
    expect(await projected()).toEqual([]);
  });

  it.each(["source", "version"] as const)(
    "rejects a new anchor with a missing %s",
    async (missing) => {
      const data = workspace();
      if (missing === "source") data.sources = [];
      else data.annotations[0]!.versionId = "missing-version";
      await expect(save(data)).rejects.toMatchObject({ code: "22023" });
      expect(await projected()).toEqual([]);
    },
  );

  it.each(["source", "historical-version"] as const)(
    "rechecks unchanged annotations when their %s is removed",
    async (missing) => {
      const old = source();
      const current = missing === "source" ? old : source("v2", "当前资料正文。", "text");
      if (missing === "historical-version") current.versions = [{ ...old, archivedAt: now }];
      const data = workspace(current, annotation(old.text));
      await save(data);
      if (missing === "source") data.sources = [];
      else data.sources[0]!.versions = [];
      await expect(save(data, 1)).rejects.toMatchObject({ code: "22023" });
      expect((await saved())!.revision).toBe(1);
      expect((await projected())[0]!.text_anchor).toEqual(annotation().textAnchor);
    },
  );

  it("strictly rejects normalized or whitespace-modified quotes", async () => {
    const text = "😀a\u0301  原话。";
    const data = workspace(source("v1", text, "text"), annotation(text, "a\u0301  原话。"));
    data.annotations[0]!.quote = "á 原话。";
    await expect(save(data)).rejects.toMatchObject({ code: "22023" });
  });

  it("counts preceding non-BMP scalars as two units and permits selecting a full surrogate pair", async () => {
    const text = "😀A𝄞学习 **梯度下降**。";
    await save(workspace(source("v1", text, "text"), annotation(text)));
    expect((await projected())[0]!.text_anchor).toEqual({ start: 5, end: text.length });
    const data = workspace(source("v1", text, "text"), {
      ...annotation(text, "😀"),
      id: "annotation-emoji",
      textAnchor: { start: 0, end: 2 },
    });
    data.annotations.push(annotation(text));
    expect(await save(data, 1)).toBe(2);
    expect((await projected()).find((row) => row.annotation_id === "annotation-emoji")!.quote).toBe(
      "😀",
    );
  });

  it.each([
    { start: 1, end: 2 },
    { start: 0, end: 1 },
    { start: 3, end: 4 },
  ])("rejects a surrogate-pair cut at %j", async (textAnchor) => {
    const text = "😀A𝄞原话。";
    const data = workspace(source("v1", text, "text"), { ...annotation(text, "😀"), textAnchor });
    await expect(save(data)).rejects.toMatchObject({ code: "22023" });
    expect(await projected()).toEqual([]);
  });

  it("rejects codepoint offsets that would point to the wrong UTF-16 raw text", async () => {
    const text = "😀A𝄞学习 **梯度下降**。";
    const data = workspace(source("v1", text, "text"), annotation(text));
    data.annotations[0]!.textAnchor = { start: 3, end: 3 + quote.length };
    await expect(save(data)).rejects.toMatchObject({ code: "22023" });
  });

  it("keeps anchored reading-only updates compatible with the fast projection gate", async () => {
    const data = workspace();
    await save(data);
    data.sources[0]!.readOffset = 120;
    data.sources[0]!.lastReadAt = "2026-09-14T12:01:00.000Z";
    expect(await save(data, 1)).toBe(2);
    expect((await projected())[0]!.text_anchor).toEqual(annotation().textAnchor);
  });

  it("removes a projected annotation only when the authoritative array removes it", async () => {
    const data = workspace();
    await save(data);
    data.annotations = [];
    expect(await save(data, 1)).toBe(2);
    expect(await projected()).toEqual([]);
  });

  it("isolates anchored reads by account and denies direct writes and private helper access", async () => {
    await save(workspace());
    const other = workspace();
    other.annotations[0]!.note = "账号 B 理解";
    await save(other, 0, ownerB);
    const rows = await asRole(
      "authenticated",
      ownerB,
      async () => (await db.query<ProjectedAnnotation>("select * from public.annotations")).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner_id: ownerB,
      note: "账号 B 理解",
      text_anchor: annotation().textAnchor,
    });
    expect(
      await asRole(
        "authenticated",
        ownerB,
        async () =>
          (await db.query("select * from public.annotations where owner_id=$1::uuid", [ownerA]))
            .rows,
      ),
    ).toEqual([]);
    await expect(
      asRole("anon", null, () => db.query("select text_anchor from public.annotations")),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole("authenticated", ownerA, () =>
        db.query("update public.annotations set note='绕过快照'"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole("authenticated", ownerA, () =>
        db.query("select conuo_private.annotation_utf16_slice('😀',0,2)"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRole("service_role", ownerA, () =>
        db.query("select conuo_private.project_annotations_from_workspace($1::uuid,$2::jsonb)", [
          ownerA,
          JSON.stringify(workspace()),
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("retains the account-deletion read fence for the new anchor column", async () => {
    await save(workspace());
    await db.query(
      "insert into public.account_deletions(deletion_id,owner_id,state) values(gen_random_uuid(),$1::uuid,'storage_pending')",
      [ownerA],
    );
    expect(
      await asRole(
        "authenticated",
        ownerA,
        async () => (await db.query("select text_anchor from public.annotations")).rows,
      ),
    ).toEqual([]);
  });

  it("accepts a deletion recovery draft that copies the exact proven annotation anchor", async () => {
    const data = recoveryWorkspace();
    expect(await save(data)).toBe(1);
    expect((await saved())!.data.recoverableDrafts).toEqual(data.recoverableDrafts);
    expect((await projected())[0]!.text_anchor).toEqual(data.recoverableDrafts![0]!.textAnchor);
  });

  it.each(["remove", "move", "malformed"] as const)(
    "rejects draft-only anchor %s while keeping its confirmed raw location",
    async (operation) => {
      const data = recoveryWorkspace();
      await save(data);
      const confirmed = structuredClone(data);
      const draft = data.recoverableDrafts![0]!;
      if (operation === "remove") delete draft.textAnchor;
      else if (operation === "malformed") draft.textAnchor = null;
      else {
        const start = sourceText.indexOf(quote);
        draft.textAnchor = { start, end: start + quote.length };
      }
      await expect(save(data, 1)).rejects.toMatchObject({ code: "22023" });
      expect((await saved())!.data).toEqual(confirmed);
      expect((await saved())!.revision).toBe(1);
      expect((await projected())[0]!.text_anchor).toEqual(annotation().textAnchor);
    },
  );

  it("rejects adding a draft anchor when the corresponding legacy annotation has none", async () => {
    const data = recoveryWorkspace(false);
    await save(data);
    data.recoverableDrafts![0]!.textAnchor = annotation().textAnchor;
    await expect(save(data, 1)).rejects.toMatchObject({ code: "22023" });
    expect((await saved())!.data.recoverableDrafts![0]).not.toHaveProperty("textAnchor");
    expect((await projected())[0]!.text_anchor).toBeNull();
  });

  it.each([
    ["annotationId", "missing-annotation"],
    ["sourceId", "other-source"],
    ["sourceVersionId", "other-version"],
    ["quote", "另一个原文位置"],
    ["note", "被悄悄替换的人工文字"],
    ["annotationCreatedAt", "2026-09-14T12:02:00.000Z"],
    ["page", 2],
  ] as const)("rejects anchored draft-only identity drift in %s", async (field, value) => {
    const data = recoveryWorkspace();
    await save(data);
    const confirmed = structuredClone(data);
    data.recoverableDrafts![0]![field] = value;
    await expect(save(data, 1)).rejects.toMatchObject({ code: "22023" });
    expect((await saved())!.data).toEqual(confirmed);
    expect((await saved())!.revision).toBe(1);
  });

  it("rejects removing the proven annotation while its anchored draft remains", async () => {
    const data = recoveryWorkspace();
    await save(data);
    data.annotations = [];
    await expect(save(data, 1)).rejects.toMatchObject({ code: "22023" });
    expect((await saved())!.revision).toBe(1);
    expect(await projected()).toHaveLength(1);
  });

  it("rejects duplicate matching annotations instead of choosing one for an anchored draft", async () => {
    const data = recoveryWorkspace();
    data.annotations.push(structuredClone(data.annotations[0]!));
    await expect(save(data)).rejects.toMatchObject({ code: "22023" });
    expect(await saved()).toBeUndefined();
  });

  it("allows draft-only removal and retains valid legacy unanchored recovery compatibility", async () => {
    const data = recoveryWorkspace(false);
    await save(data);
    data.recoverableDrafts = [];
    expect(await save(data, 1)).toBe(2);
    expect((await projected())[0]!.text_anchor).toBeNull();
    const anchored = recoveryWorkspace();
    anchored.annotations[0]!.id = "annotation-new";
    anchored.recoverableDrafts![0]!.annotationId = "annotation-new";
    expect(await save(anchored, 2)).toBe(3);
    anchored.recoverableDrafts = [];
    expect(await save(anchored, 3)).toBe(4);
    expect((await projected())[0]!.text_anchor).toEqual(annotation().textAnchor);
  });

  it("preserves the previous unanchored SQL boundary without claiming full legacy recovery validation", async () => {
    const data = recoveryWorkspace(false);
    data.recoverableDrafts![0]!.annotationId = "legacy-missing-annotation";
    expect(await save(data)).toBe(1);
    expect((await saved())!.data.recoverableDrafts).toEqual(data.recoverableDrafts);
  });

  it.each([null, {}, [null], Array.from({ length: 20_001 }, () => ({}))])(
    "rejects malformed or oversized recoverable-draft containers without a partial save",
    async (recoverableDrafts) => {
      const data = recoveryWorkspace();
      await expect(save({ ...data, recoverableDrafts })).rejects.toMatchObject({ code: "22023" });
      expect(await saved()).toBeUndefined();
      expect(await projected()).toEqual([]);
    },
  );
});
