import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/indexing/route";
import { readEmbeddingConfig } from "@/lib/ai/embeddings";
import type { Source, SourceVersion, WorkspaceData } from "../types";

// Only the PostgREST transport is replaced. Named RPC arguments execute unchanged
// against the original SQL migrations; jobs, leases, usage, and vectors are real SQL data.
const store = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/ai/requests", () => ({ createRequestStore: () => store }));

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secret = "test-only-processor-secret-never-real";
const providerKey = "test-only-provider-key-never-real";
const model = "local-test-1536";
const createdAt = "2026-09-12T12:00:00.000Z";
const processorDirectory = fileURLToPath(new URL("../../../../processor/", import.meta.url));
let db: PGlite;
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
const sqlErrors: unknown[] = [];

type Hit = { source_id: string; version_id: string; chunk_id: string; distance: number };
type RecordLine = { state: string; code: string; jobId?: string };
type RequestTrace = { action: string; status: number; body: Record<string, unknown> };

function source(versionId = "v1", count = 18): Source {
  const chunks = Array.from({ length: count }, (_, index) => ({
    id: `chunk-${index}`,
    sourceId: "pipeline-source",
    versionId,
    text: `${versionId} passage ${index}: ${index === count - 1 ? "priority" : "background"} test-only content.`,
    section: `Section ${index}`,
    order: index * 3 + 5,
  }));
  return {
    id: "pipeline-source",
    versionId,
    title: "Pipeline test source",
    filename: "pipeline.md",
    kind: "markdown",
    mime: "text/markdown",
    size: 500,
    hash: `test-${versionId}`,
    spaceIds: ["library"],
    tags: [],
    status: "ready",
    text: chunks.map((chunk) => chunk.text).join("\n\n"),
    chunks,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    aiAllowed: true,
    starred: false,
  };
}

function workspace(sources = [source()]): WorkspaceData {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "library", name: "Library", goal: "", color: "blue", archived: false, createdAt },
    ],
    sources,
    notes: [],
    annotations: [],
    conversations: [],
    aiEnabled: true,
    semanticSearch: true,
  } as WorkspaceData;
}

function archived(value: Source): SourceVersion {
  return {
    versionId: value.versionId,
    title: value.title,
    filename: value.filename,
    kind: value.kind,
    mime: value.mime,
    size: value.size,
    hash: value.hash,
    status: value.status,
    text: value.text,
    chunks: structuredClone(value.chunks),
    createdAt: value.createdAt,
    archivedAt: createdAt,
  };
}

async function asRole<T>(
  role: "authenticated" | "service_role",
  user: string | null,
  action: () => Promise<T>,
): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [user ?? ""]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await action();
  } finally {
    await db.exec("RESET ROLE");
  }
}

async function save(data: WorkspaceData, revision = 0, user = owner) {
  return asRole("authenticated", user, async () => {
    const result = await db.query<{ revision: number }>(
      "SELECT public.save_workspace($1::jsonb,$2::bigint) AS revision",
      [JSON.stringify(data), revision],
    );
    return result.rows[0].revision;
  });
}

function unitVector(axis: number) {
  return Array.from({ length: 1536 }, (_, index) => (index === axis ? 1 : 0));
}

async function semantic(fingerprint: string, user = owner) {
  return asRole("authenticated", user, async () => {
    const result = await db.query<Hit>(
      "SELECT * FROM public.semantic_source_chunks($1::jsonb,'library',$2,null,100)",
      [JSON.stringify(unitVector(0)), fingerprint],
    );
    return result.rows;
  });
}

beforeAll(async () => {
  db = await PGlite.create("memory://", { extensions: { vector } });
  try {
    await db.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      INSERT INTO auth.users VALUES ('${owner}'),('${otherOwner}');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(bucket_id text,name text);
      CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
        $$ SELECT string_to_array($1,'/') $$;
    `);
    for (const name of [
      "202609120001_workspace_foundation.sql",
      "202609120002_ai_requests.sql",
      "202609120003_source_retrieval.sql",
    ]) {
      await db.exec(
        await readFile(
          new URL(`../../../../../supabase/migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    }
  } catch (error) {
    await db.close();
    throw error;
  }
  store.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    try {
      if (!/^[a-z_]+$/.test(name) || Object.keys(args).some((key) => !/^p_[a-z_]+$/.test(key)))
        throw new Error("Unexpected test RPC identifier");
      const entries = Object.entries(args);
      const named = entries.map(([key], index) => `${key} => $${index + 1}`).join(",");
      const params = entries.map(([, value]) =>
        typeof value === "object" && value !== null ? JSON.stringify(value) : value,
      );
      const data = await asRole("service_role", null, async () => {
        const result = await db.query<{ data: unknown }>(
          `SELECT public.${name}(${named}) AS data`,
          params,
        );
        return result.rows[0].data;
      });
      return { data, error: null };
    } catch (error) {
      sqlErrors.push(error);
      return { data: null, error };
    }
  });
}, 30_000);

beforeEach(async () => {
  rpcCalls.length = 0;
  sqlErrors.length = 0;
  store.rpc.mockClear();
  await db.exec(
    "RESET ROLE; TRUNCATE public.workspaces CASCADE; TRUNCATE public.embedding_usage; UPDATE public.embedding_profiles SET fingerprint=null; SET TIME ZONE 'UTC';",
  );
});

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (db && !db.closed) await db.close();
});

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function withHTTP<T>(
  run: (context: {
    origin: string;
    fingerprint: string;
    trace: RequestTrace[];
    providerInputs: string[][];
  }) => Promise<T>,
  beforeProviderReply?: () => Promise<void>,
) {
  const trace: RequestTrace[] = [];
  const providerInputs: string[][] = [];
  const serverErrors: unknown[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const parts: Buffer[] = [];
      let length = 0;
      for await (const part of incoming) {
        length += part.length;
        if (length > 1_500_000) throw new Error("Test HTTP request too large");
        parts.push(part);
      }
      const body = Buffer.concat(parts).toString("utf8");
      const payload = JSON.parse(body) as Record<string, unknown>;
      if (incoming.url === "/api/internal/indexing") {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        const controller = new AbortController();
        incoming.once("aborted", () => controller.abort());
        outgoing.once("close", () => {
          if (!outgoing.writableEnded) controller.abort();
        });
        const result = await POST(
          new Request(`http://${incoming.headers.host}${incoming.url}`, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          }),
        );
        trace.push({ action: String(payload.action), status: result.status, body: payload });
        result.headers.forEach((value, name) => outgoing.setHeader(name, value));
        outgoing.writeHead(result.status);
        outgoing.end(Buffer.from(await result.arrayBuffer()));
      } else if (incoming.url === "/v1/embeddings") {
        expect(incoming.headers.authorization).toBe(`Bearer ${providerKey}`);
        expect(payload.model).toBe(model);
        expect(payload.encoding_format).toBe("float");
        const inputs = payload.input as string[];
        expect(Array.isArray(inputs)).toBe(true);
        providerInputs.push(inputs);
        await beforeProviderReply?.();
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        // Mathematical vectors exist only in this test provider. Reverse response
        // order to require the real Python adapter to honor provider indices.
        outgoing.end(
          JSON.stringify({
            object: "list",
            model,
            data: inputs
              .map((text, index) => ({
                object: "embedding",
                index,
                embedding: unitVector(text.includes("priority") ? 0 : 1),
              }))
              .reverse(),
          }),
        );
      } else {
        outgoing.writeHead(404);
        outgoing.end();
      }
    } catch (error) {
      serverErrors.push(error);
      if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ code: "TEST_HARNESS_FAILED" }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local test port");
    const origin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("CONUO_PROCESSOR_SECRET", secret);
    vi.stubEnv("CONUO_EMBEDDING_BASE_URL", `${origin}/v1`);
    vi.stubEnv("CONUO_EMBEDDING_API_KEY", providerKey);
    vi.stubEnv("CONUO_EMBEDDING_MODEL", model);
    vi.stubEnv("CONUO_EMBEDDING_DAILY_CHAR_LIMIT", "200000");
    const fingerprint = readEmbeddingConfig()!.fingerprint;
    const result = await run({ origin, fingerprint, trace, providerInputs });
    expect(serverErrors).toEqual([]);
    return result;
  } finally {
    if (server.listening) await closeServer(server);
  }
}

async function runPython(origin: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("CONUO_")),
  );
  const child = spawn(
    "python",
    ["-B", "-m", "conuo_processor", "--max-jobs", "1", "--max-seconds", "12"],
    {
      cwd: processorDirectory,
      env: {
        ...env,
        NODE_ENV: "test",
        PYTHONDONTWRITEBYTECODE: "1",
        CONUO_PROCESSOR_ENDPOINT: `${origin}/api/internal/indexing`,
        CONUO_PROCESSOR_SECRET: secret,
        CONUO_EMBEDDING_BASE_URL: `${origin}/v1`,
        CONUO_EMBEDDING_API_KEY: providerKey,
        CONUO_EMBEDDING_MODEL: model,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    stdout += text;
    if (stdout.length > 64_000) child.kill("SIGKILL");
  });
  child.stderr.on("data", (text: string) => {
    stderr += text;
    if (stderr.length > 64_000) child.kill("SIGKILL");
  });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(stderr).toBe("");
    for (const value of [secret, providerKey, owner, "test-only content"])
      expect(stdout).not.toContain(value);
    return {
      exitCode,
      records: stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordLine),
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

describe("Python → real Next handler → PostgreSQL + pgvector", () => {
  it("publishes two HTTP batches and ranks only the owner's current vectors", async () => {
    const data = workspace();
    await save(workspace([]), 0, otherOwner);
    expect(await save(data)).toBe(1);
    await withHTTP(async ({ origin, fingerprint, trace, providerInputs }) => {
      const result = await runPython(origin);
      expect(result, JSON.stringify(sqlErrors)).toMatchObject({
        exitCode: 0,
        records: [{ state: "completed", code: "PUBLISHED" }],
      });
      expect(sqlErrors).toEqual([]);
      expect(trace.map((request) => [request.action, request.status])).toEqual([
        ["claim", 200],
        ["read", 200],
        ["commit", 200],
        ["read", 200],
        ["commit", 200],
        ["finish", 200],
      ]);
      expect(trace.every((request) => request.body.profileFingerprint === fingerprint)).toBe(true);
      expect(providerInputs.map((inputs) => inputs.length)).toEqual([16, 2]);
      expect(rpcCalls.map((call) => call.name)).toEqual([
        "claim_embedding_jobs",
        "read_embedding_batch",
        "reserve_embedding_usage",
        "heartbeat_embedding_job",
        "commit_embedding_batch",
        "read_embedding_batch",
        "reserve_embedding_usage",
        "heartbeat_embedding_job",
        "commit_embedding_batch",
        "finish_embedding_job",
      ]);
      const jobs = await db.query<{ state: string; cursor: number; total_chunks: number }>(
        "SELECT state,cursor,total_chunks FROM public.embedding_jobs",
      );
      expect(jobs.rows).toEqual([{ state: "succeeded", cursor: 18, total_chunks: 18 }]);
      const usage = await db.query<{ characters: number; reservations: number }>(
        "SELECT sum(characters)::int AS characters,count(*)::int AS reservations FROM public.embedding_usage WHERE owner_id=$1::uuid",
        [owner],
      );
      expect(usage.rows).toEqual([
        {
          characters: data.sources[0].chunks.reduce(
            (sum, chunk) => sum + [...chunk.text].length,
            0,
          ),
          reservations: 2,
        },
      ]);
      expect(
        (await db.query("SELECT * FROM public.chunk_embeddings WHERE published")).rows,
      ).toHaveLength(18);
      const hits = await semantic(fingerprint);
      expect(hits).toHaveLength(18);
      expect(hits[0]).toMatchObject({
        source_id: "pipeline-source",
        version_id: "v1",
        chunk_id: "chunk-17",
        distance: 0,
      });
      expect(hits[1].distance).toBe(1);
      expect(hits.every((hit) => hit.version_id === "v1")).toBe(true);
      expect(await semantic(fingerprint, otherOwner)).toEqual([]);
    });
  }, 25_000);

  it("rejects old lease commit when the current version changes during the real provider call", async () => {
    const original = source("v1", 2);
    await save(workspace([original]));
    let replaced = false;
    await withHTTP(
      async ({ origin, fingerprint, trace, providerInputs }) => {
        const result = await runPython(origin);
        expect(replaced).toBe(true);
        expect(result).toMatchObject({
          exitCode: 1,
          records: [{ state: "stale", code: "LEASE_OR_CONTEXT_CHANGED" }],
        });
        expect(trace.map((request) => [request.action, request.status])).toEqual([
          ["claim", 200],
          ["read", 200],
          ["commit", 409],
        ]);
        expect(providerInputs).toHaveLength(1);
        expect(sqlErrors).toHaveLength(1);
        expect(sqlErrors[0]).toMatchObject({ code: "40001" });
        expect(rpcCalls.map((call) => call.name)).not.toContain("finish_embedding_job");
        const jobs = await db.query<{ version_id: string; state: string }>(
          "SELECT version_id,state FROM public.embedding_jobs ORDER BY version_id",
        );
        expect(jobs.rows).toEqual([
          { version_id: "v1", state: "cancelled" },
          { version_id: "v2", state: "queued" },
        ]);
        expect(
          (await db.query("SELECT * FROM public.chunk_embeddings WHERE published")).rows,
        ).toEqual([]);
        expect(await semantic(fingerprint)).toEqual([]);
        expect((await db.query("SELECT * FROM public.embedding_usage")).rows).toHaveLength(1);
      },
      async () => {
        expect(replaced).toBe(false);
        const next = source("v2", 2);
        next.versions = [archived(original)];
        expect(await save(workspace([next]), 1)).toBe(2);
        replaced = true;
      },
    );
  }, 25_000);
});
