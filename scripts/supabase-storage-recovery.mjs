import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createClient } from "@supabase/supabase-js";

const stagingProjectRef = "yyleaedclbhsiowsaunt";
const productionProjectRef = "czcurayfzshrqievceww";

const [command, ...rawArguments] = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < rawArguments.length; index += 2) {
  const name = rawArguments[index];
  const value = rawArguments[index + 1];
  if (!name?.startsWith("--") || value === undefined)
    throw new Error(`Invalid option: ${name}`);
  options.set(name, value);
}

function usage() {
  console.log(`Usage:
  node scripts/supabase-storage-recovery.mjs backup --directory <path> --confirm-source-ref <ref>
  node scripts/supabase-storage-recovery.mjs restore --directory <path> --confirm-target-ref <ref>
  node scripts/supabase-storage-recovery.mjs verify --directory <path> --confirm-target-ref <ref>

Environment:
  backup: CONUO_DR_SOURCE_URL, CONUO_DR_SOURCE_SERVICE_KEY
  restore/verify: CONUO_DR_TARGET_URL, CONUO_DR_TARGET_SERVICE_KEY`);
}

if (!command || command === "help" || options.has("--help")) {
  usage();
  process.exit(0);
}
if (!new Set(["backup", "restore", "verify"]).has(command))
  throw new Error(`Unknown command: ${command}`);

const directoryOption = options.get("--directory");
if (!directoryOption) throw new Error("--directory is required");
const directory = resolve(directoryOption);
const manifestPath = resolve(directory, "storage-backup-manifest.json");
const objectsDirectory = resolve(directory, "objects");

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function projectRef(urlValue) {
  const host = new URL(urlValue).hostname;
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(host);
  if (!match)
    throw new Error("Supabase URL must use the project.supabase.co host");
  return match[1];
}

function clientFor(kind) {
  const source = kind === "source";
  const url = requiredEnvironment(
    source ? "CONUO_DR_SOURCE_URL" : "CONUO_DR_TARGET_URL",
  );
  const key = requiredEnvironment(
    source ? "CONUO_DR_SOURCE_SERVICE_KEY" : "CONUO_DR_TARGET_SERVICE_KEY",
  );
  const ref = projectRef(url);
  const confirmation = options.get(
    source ? "--confirm-source-ref" : "--confirm-target-ref",
  );
  assert.equal(
    confirmation,
    ref,
    `Explicit project ref confirmation must equal ${ref}`,
  );
  if (source)
    assert.equal(
      ref,
      stagingProjectRef,
      "Backup is restricted to Conuo staging",
    );
  else {
    assert.notEqual(
      ref,
      stagingProjectRef,
      "Restore target cannot be Conuo staging",
    );
    assert.notEqual(
      ref,
      productionProjectRef,
      "Restore target cannot be Conuo production",
    );
  }
  return {
    ref,
    client: createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
}

async function listObjects(client, bucketName, prefix = "") {
  const objects = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.storage.from(bucketName).list(prefix, {
      limit: 1000,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error)
      throw new Error(`Unable to list bucket ${bucketName}: ${error.message}`);
    for (const item of data ?? []) {
      const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.metadata)
        objects.push({ path: fullPath, metadata: item.metadata });
      else objects.push(...(await listObjects(client, bucketName, fullPath)));
    }
    if (!data || data.length < 1000) break;
  }
  return objects;
}

function hashBuffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(
    manifest.schemaVersion,
    1,
    "Unsupported storage manifest version",
  );
  assert.ok(
    Array.isArray(manifest.buckets),
    "Storage manifest buckets are required",
  );
  return manifest;
}

async function backup() {
  const { client, ref } = clientFor("source");
  try {
    await stat(manifestPath);
    throw new Error(`Backup manifest already exists: ${manifestPath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(objectsDirectory, { recursive: true });
  const marker = resolve(directory, ".storage-backup-incomplete");
  await writeFile(marker, "storage backup in progress\n", "utf8");
  const { data: buckets, error } = await client.storage.listBuckets();
  if (error) throw new Error(`Unable to list buckets: ${error.message}`);

  const manifestBuckets = [];
  let totalBytes = 0;
  let objectCount = 0;
  for (const bucket of [...(buckets ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const objects = await listObjects(client, bucket.name);
    const manifestObjects = [];
    for (const object of objects.sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      const downloaded = await client.storage
        .from(bucket.name)
        .download(object.path);
      if (downloaded.error || !downloaded.data) {
        throw new Error(
          `Unable to download an object from ${bucket.name}: ${downloaded.error?.message}`,
        );
      }
      const bytes = Buffer.from(await downloaded.data.arrayBuffer());
      const sha256 = hashBuffer(bytes);
      const objectFile = resolve(objectsDirectory, sha256);
      assert.ok(
        objectFile.startsWith(`${objectsDirectory}${sep}`),
        "Object path escaped backup directory",
      );
      try {
        await stat(objectFile);
      } catch (fileError) {
        if (fileError.code !== "ENOENT") throw fileError;
        await writeFile(objectFile, bytes);
      }
      manifestObjects.push({
        path: object.path,
        bytes: bytes.length,
        sha256,
        contentType: object.metadata?.mimetype ?? "application/octet-stream",
        cacheControl: object.metadata?.cacheControl ?? null,
      });
      objectCount += 1;
      totalBytes += bytes.length;
    }
    manifestBuckets.push({
      name: bucket.name,
      public: Boolean(bucket.public),
      fileSizeLimit: bucket.file_size_limit ?? null,
      allowedMimeTypes: bucket.allowed_mime_types ?? null,
      objects: manifestObjects,
    });
  }

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceProjectRef: ref,
    bucketCount: manifestBuckets.length,
    objectCount,
    totalBytes,
    buckets: manifestBuckets,
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await rm(marker);
  console.log(
    JSON.stringify({
      bucketCount: manifest.bucketCount,
      objectCount,
      totalBytes,
    }),
  );
}

async function ensureBucket(client, bucket) {
  const current = await client.storage.getBucket(bucket.name);
  if (!current.error && current.data) return;
  const created = await client.storage.createBucket(bucket.name, {
    public: bucket.public,
    fileSizeLimit: bucket.fileSizeLimit,
    allowedMimeTypes: bucket.allowedMimeTypes,
  });
  if (created.error)
    throw new Error(
      `Unable to create bucket ${bucket.name}: ${created.error.message}`,
    );
}

async function restore() {
  const manifest = await loadManifest();
  const { client, ref } = clientFor("target");
  assert.notEqual(
    ref,
    manifest.sourceProjectRef,
    "Restore target must differ from the source project",
  );
  let restored = 0;
  for (const bucket of manifest.buckets) {
    await ensureBucket(client, bucket);
    for (const object of bucket.objects) {
      const bytes = await readFile(resolve(objectsDirectory, object.sha256));
      assert.equal(
        hashBuffer(bytes),
        object.sha256,
        "Local storage backup checksum mismatch",
      );
      const uploaded = await client.storage
        .from(bucket.name)
        .upload(object.path, bytes, {
          upsert: true,
          contentType: object.contentType,
          cacheControl: object.cacheControl ?? undefined,
        });
      if (uploaded.error)
        throw new Error(
          `Unable to restore an object into ${bucket.name}: ${uploaded.error.message}`,
        );
      restored += 1;
    }
  }
  const result = {
    restoredAt: new Date().toISOString(),
    targetProjectRef: ref,
    restored,
    passed: true,
  };
  await writeFile(
    resolve(directory, "storage-restore-results.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify({ restored, passed: true }));
}

async function verify() {
  const manifest = await loadManifest();
  const { client, ref } = clientFor("target");
  assert.notEqual(
    ref,
    manifest.sourceProjectRef,
    "Verification target must differ from the source project",
  );
  let verified = 0;
  for (const bucket of manifest.buckets) {
    const actualObjects = await listObjects(client, bucket.name);
    assert.equal(
      actualObjects.length,
      bucket.objects.length,
      `Object count mismatch in bucket ${bucket.name}`,
    );
    const actualPaths = new Set(actualObjects.map((item) => item.path));
    for (const object of bucket.objects) {
      assert.ok(
        actualPaths.has(object.path),
        `A restored object is missing from bucket ${bucket.name}`,
      );
      const downloaded = await client.storage
        .from(bucket.name)
        .download(object.path);
      if (downloaded.error || !downloaded.data) {
        throw new Error(
          `Unable to verify an object in ${bucket.name}: ${downloaded.error?.message}`,
        );
      }
      const bytes = Buffer.from(await downloaded.data.arrayBuffer());
      assert.equal(
        bytes.length,
        object.bytes,
        "Restored object byte length mismatch",
      );
      assert.equal(
        hashBuffer(bytes),
        object.sha256,
        "Restored object checksum mismatch",
      );
      verified += 1;
    }
  }
  const result = {
    verifiedAt: new Date().toISOString(),
    targetProjectRef: ref,
    verified,
    passed: true,
  };
  await writeFile(
    resolve(directory, "storage-verification-results.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify({ verified, passed: true }));
}

await mkdir(dirname(manifestPath), { recursive: true });
if (command === "backup") await backup();
if (command === "restore") await restore();
if (command === "verify") await verify();
