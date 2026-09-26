import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEmptyWorkspace } from "../seed";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const spaceOwner = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const deletedOwner = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const fingerprint = "a".repeat(64);
const migrations = new URL("../../../../../supabase/migrations/", import.meta.url);
let db: PGlite;

type Json = Record<string, unknown>;

async function asRole<T>(
  role: "anon" | "authenticated" | "service_role",
  action: () => Promise<T>,
) {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await action();
  } finally {
    await db.exec("RESET ROLE");
  }
}

async function value<T = Json>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, params)).rows[0]!.value;
}

async function grant(
  account: string,
  plan: string,
  source: string,
  endsAt: string | null,
  startsAt = "now()",
) {
  return value<string>(
    `select conuo_private.grant_membership($1::uuid,$2,$3,${startsAt},${endsAt ?? "null"},'admin@example.com','test grant') as value`,
    [account, plan, source],
  );
}

async function effective(account: string, at = "now()") {
  return value<Json>(`select conuo_private.effective_membership($1::uuid, ${at}) as value`, [
    account,
  ]);
}

function reserve(
  account: string,
  requestId: string,
  enforcement: "off" | "shadow" | "on",
  options: { cap?: number; features?: string[] | null; route?: string; hash?: string } = {},
) {
  return asRole("service_role", () =>
    value<Json>(
      "select public.reserve_membership_ai_request($1::uuid,$2,$3,$4,$5::text[],$6,$7) as value",
      [
        account,
        requestId,
        options.hash ?? fingerprint,
        options.route ?? "ask",
        options.features ?? null,
        options.cap ?? 50,
        enforcement,
      ],
    ),
  );
}

async function saveWorkspace(account: string, data: unknown, revision: number) {
  await db.exec(
    `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${account}',false);`,
  );
  try {
    return await value<number>("select public.save_workspace($1::jsonb,$2) as value", [
      JSON.stringify(data),
      revision,
    ]);
  } finally {
    await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false);");
  }
}

function workspaceWithSpaces(spaces: { id: string; archived: boolean }[]) {
  const data = createEmptyWorkspace();
  data.spaces = spaces.map((space) => ({
    id: space.id,
    name: `空间 ${space.id}`,
    goal: "",
    color: "#4B3FE3",
    archived: space.archived,
    createdAt: "2026-09-27T00:00:00.000Z",
  }));
  return data;
}

beforeAll(async () => {
  db = await PGlite.create("memory://", { extensions: { vector } });
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${owner}'),('${otherOwner}'),('${spaceOwner}'),('${deletedOwner}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb not null default '{}'::jsonb); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1,'/') $$;
    GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role; GRANT SELECT,INSERT,DELETE ON storage.objects TO authenticated;
  `);
  const names = (await readdir(migrations))
    .filter((name) => name.endsWith(".sql") && !name.startsWith("._"))
    .sort();
  for (const name of names) await db.exec(await readFile(new URL(name, migrations), "utf8"));
}, 60_000);

beforeEach(async () => {
  await db.exec(`
    RESET ROLE;
    DELETE FROM conuo_private.membership_grants;
    DELETE FROM conuo_private.ai_token_usage_ledger;
    DELETE FROM public.ai_requests;
    UPDATE public.membership_plans SET learning_space_limit = 500, is_grantable = true,
      features = '{"vision_region":true,"organization":true,"learning_ai":true,"deep_thinking":true,"tutor_mode":true}';
  `);
});

afterAll(async () => {
  if (db && !db.closed) await db.close();
});

describe("membership plans and grants", () => {
  it("seeds the three plans and resolves an account without grants to free", async () => {
    expect(
      (
        await db.query(
          "select code, tier_rank, ai_daily_request_limit from public.membership_plans order by tier_rank",
        )
      ).rows,
    ).toEqual([
      { code: "free", tier_rank: 0, ai_daily_request_limit: 20 },
      { code: "pro", tier_rank: 10, ai_daily_request_limit: 100 },
      { code: "max", tier_rank: 20, ai_daily_request_limit: 300 },
    ]);
    expect(await effective(owner)).toMatchObject({
      planCode: "free",
      source: null,
      endsAt: null,
      limits: { aiDailyRequests: 20, learningSpaces: 500 },
    });
  });

  it("keeps a permanent higher grant when a lower promotion is added", async () => {
    await grant(owner, "max", "manual", null);
    await grant(owner, "pro", "promotion", "now() + interval '30 days'");
    expect(await effective(owner)).toMatchObject({ planCode: "max", endsAt: null });
    expect(await effective(owner, "now() + interval '31 days'")).toMatchObject({ planCode: "max" });
  });

  it("falls back to the underlying grant when a higher promotion ends", async () => {
    await grant(owner, "pro", "manual", null);
    await grant(owner, "max", "promotion", "now() + interval '7 days'");
    expect(await effective(owner)).toMatchObject({ planCode: "max", afterEnd: "pro" });
    expect(await effective(owner, "now() + interval '8 days'")).toMatchObject({
      planCode: "pro",
      afterEnd: null,
    });
  });

  it("ignores future grants until they start and falls back to free after expiry", async () => {
    await grant(owner, "pro", "manual", "now() + interval '10 days'", "now() + interval '2 days'");
    expect(await effective(owner)).toMatchObject({ planCode: "free" });
    expect(await effective(owner, "now() + interval '3 days'")).toMatchObject({
      planCode: "pro",
      afterEnd: "free",
    });
    expect(await effective(owner, "now() + interval '11 days'")).toMatchObject({
      planCode: "free",
    });
  });

  it("rejects invalid grants", async () => {
    const invalid = [
      "select conuo_private.grant_membership($1::uuid,'pro','manual',now(),null,'','reason')",
      "select conuo_private.grant_membership($1::uuid,'pro','manual',now(),null,'admin',' ')",
      "select conuo_private.grant_membership($1::uuid,'gold','manual',now(),null,'admin','reason')",
      "select conuo_private.grant_membership($1::uuid,'pro','payment',now(),null,'admin','reason')",
      "select conuo_private.grant_membership($1::uuid,'pro','promotion',now(),null,'admin','reason')",
      "select conuo_private.grant_membership($1::uuid,'pro','manual',now(),now() - interval '1 day','admin','reason')",
    ];
    for (const sql of invalid)
      await expect(db.query(sql, [owner])).rejects.toMatchObject({ code: "22023" });
    await expect(
      db.query(
        "select conuo_private.grant_membership('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','pro','manual',now(),null,'admin','reason')",
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await db.exec("UPDATE public.membership_plans SET is_grantable = false WHERE code = 'max'");
    await expect(grant(owner, "max", "manual", null)).rejects.toMatchObject({ code: "22023" });
  });

  it("keeps existing grants of a plan that is no longer grantable", async () => {
    await grant(owner, "max", "manual", null);
    await db.exec("UPDATE public.membership_plans SET is_grantable = false WHERE code = 'max'");
    expect(await effective(owner)).toMatchObject({ planCode: "max" });
  });

  it("only allows recording a revocation once", async () => {
    const id = await grant(owner, "pro", "manual", null);
    await expect(
      db.query("update conuo_private.membership_grants set plan_code = 'max' where grant_id = $1", [
        id,
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    await db.query("select conuo_private.revoke_membership_grant($1,'admin','mistake')", [id]);
    expect(await effective(owner)).toMatchObject({ planCode: "free" });
    await expect(
      db.query("select conuo_private.revoke_membership_grant($1,'admin','again')", [id]),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      db.query("select conuo_private.revoke_membership_grant($1,'','no actor')", [
        await grant(owner, "pro", "manual", null),
      ]),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("downgrades to free by revoking current and future non-payment grants", async () => {
    await grant(owner, "pro", "manual", null);
    await grant(owner, "max", "promotion", "now() + interval '9 days'", "now() + interval '1 day'");
    expect(
      await value<number>(
        "select conuo_private.revoke_active_memberships($1,'admin','downgrade') as value",
        [owner],
      ),
    ).toBe(2);
    expect(await effective(owner, "now() + interval '2 days'")).toMatchObject({ planCode: "free" });
  });

  it("protects the free plan", async () => {
    await expect(
      db.query("delete from public.membership_plans where code = 'free'"),
    ).rejects.toBeTruthy();
    await expect(
      db.query("update public.membership_plans set code = 'basic' where code = 'free'"),
    ).rejects.toBeTruthy();
    await expect(
      db.query(
        "update public.membership_plans set features = '{\"unknown\":true}' where code = 'pro'",
      ),
    ).rejects.toBeTruthy();
  });

  it("fails closed when the free plan cannot be read", async () => {
    await db.exec(
      "BEGIN; ALTER TABLE public.membership_plans DISABLE TRIGGER membership_plans_guard",
    );
    try {
      await db.exec(
        "DELETE FROM public.membership_plans WHERE code = 'free'; SAVEPOINT missing_free",
      );
      await expect(effective(owner)).rejects.toMatchObject({ code: "P0001" });
      await db.exec("ROLLBACK TO SAVEPOINT missing_free");
      // Called directly: a role reset inside an aborted transaction would mask the error.
      await expect(
        db.query(
          "select public.reserve_membership_ai_request($1::uuid,'no-free',$2,'ask',null,50,'on')",
          [owner, fingerprint],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      await db.exec("ROLLBACK TO SAVEPOINT missing_free");
      expect(await reserve(owner, "no-free-shadow", "shadow")).toMatchObject({
        status: "reserved",
        shadow: { error: "MEMBERSHIP_UNAVAILABLE" },
      });
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("exposes grants and administration to no API role", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await expect(
        asRole(role, () => db.query("select * from conuo_private.membership_grants")),
      ).rejects.toBeTruthy();
      await expect(
        asRole(role, () =>
          db.query(
            "select conuo_private.grant_membership($1::uuid,'max','manual',now(),null,'self','upgrade')",
            [owner],
          ),
        ),
      ).rejects.toBeTruthy();
    }
    await expect(
      asRole("authenticated", () =>
        db.query("select public.resolve_membership($1::uuid)", [owner]),
      ),
    ).rejects.toBeTruthy();
  });

  it("returns only the caller's resolved membership and public plans", async () => {
    await grant(owner, "pro", "manual", null);
    await db.exec(
      "INSERT INTO public.membership_plans(code,name,tier_rank,is_public,ai_daily_request_limit,learning_space_limit) VALUES ('staff','内部',100,false,500,500)",
    );
    try {
      await db.exec(`SELECT set_config('request.jwt.claim.sub','${owner}',false)`);
      expect(
        await asRole("authenticated", () => value("select public.my_membership() as value")),
      ).toMatchObject({
        planCode: "pro",
      });
      expect(
        (
          await asRole("authenticated", () =>
            db.query("select code from public.membership_plans order by tier_rank"),
          )
        ).rows,
      ).toEqual([{ code: "free" }, { code: "pro" }, { code: "max" }]);
      await db.exec("SELECT set_config('request.jwt.claim.sub','',false)");
      await expect(
        asRole("authenticated", () => db.query("select public.my_membership()")),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.exec(
        "SELECT set_config('request.jwt.claim.sub','',false); DELETE FROM public.membership_plans WHERE code = 'staff'",
      );
    }
  });

  it("cascades grants when the account is deleted", async () => {
    await grant(deletedOwner, "pro", "manual", null);
    await db.query("delete from auth.users where id = $1", [deletedOwner]);
    expect(
      (
        await db.query("select 1 from conuo_private.membership_grants where owner_id = $1", [
          deletedOwner,
        ])
      ).rows,
    ).toHaveLength(0);
  });
});

describe("membership AI reservation", () => {
  async function fillToday(account: string, count: number) {
    await db.query(
      `insert into public.ai_requests(owner_id,request_id,fingerprint,state)
       select $1::uuid, 'used-' || n, $2, 'completed' from generate_series(1,$3::integer) n`,
      [account, fingerprint, count],
    );
  }

  it("uses only the global cap when enforcement is off", async () => {
    await fillToday(owner, 20);
    expect(await reserve(owner, "off-1", "off", { cap: 50 })).toEqual({ status: "reserved" });
    expect(
      (await db.query("select route from public.ai_requests where request_id = 'off-1'")).rows,
    ).toEqual([{ route: "ask" }]);
  });

  it("enforces min(plan, cap) when on", async () => {
    await fillToday(owner, 20);
    expect(await reserve(owner, "on-free", "on")).toEqual({ status: "limited" });
    await grant(owner, "pro", "manual", null);
    expect(await reserve(owner, "on-pro", "on", { cap: 21 })).toEqual({ status: "reserved" });
    await db.exec("UPDATE public.ai_requests SET state = 'completed'");
    expect(await reserve(owner, "on-cap", "on", { cap: 21 })).toEqual({ status: "limited" });
  });

  it("reports but never blocks in shadow mode", async () => {
    await fillToday(owner, 20);
    expect(
      await reserve(owner, "shadow-1", "shadow", { features: ["learning_ai"], route: "learning" }),
    ).toEqual({
      status: "reserved",
      shadow: { planCode: "free", planLimit: 20, wouldLimit: true, featureAllowed: true },
    });
  });

  it("refuses a disabled feature before consuming a request", async () => {
    await db.exec(
      `UPDATE public.membership_plans SET features = features || '{"learning_ai":false}' WHERE code = 'free'`,
    );
    expect(
      await reserve(owner, "feature", "on", { features: ["learning_ai"], route: "learning" }),
    ).toEqual({
      status: "feature_unavailable",
      planCode: "free",
    });
    expect((await db.query("select 1 from public.ai_requests")).rows).toHaveLength(0);
    expect(
      await reserve(owner, "feature-mixed", "on", { features: ["deep_thinking", "learning_ai"] }),
    ).toMatchObject({ status: "feature_unavailable" });
    expect(
      await reserve(owner, "feature-ok", "on", { features: ["deep_thinking", "tutor_mode"] }),
    ).toEqual({
      status: "reserved",
    });
    await db.exec("DELETE FROM public.ai_requests");
    expect(
      await reserve(owner, "feature-shadow", "shadow", {
        features: ["learning_ai"],
        route: "learning",
      }),
    ).toMatchObject({
      status: "reserved",
      shadow: { featureAllowed: false },
    });
  });

  it("replays a completed request after a downgrade", async () => {
    await grant(owner, "pro", "manual", null);
    expect(await reserve(owner, "replay", "on")).toEqual({ status: "reserved" });
    await db.exec(
      `UPDATE public.ai_requests SET state = 'completed', result = '{"answer":"saved"}' WHERE request_id = 'replay'`,
    );
    await db.query("select conuo_private.revoke_active_memberships($1,'admin','downgrade')", [
      owner,
    ]);
    await fillToday(owner, 30);
    expect(await reserve(owner, "replay", "on")).toEqual({
      status: "completed",
      result: { answer: "saved" },
      errorCode: null,
    });
  });

  it("validates arguments and is service-role only", async () => {
    await expect(reserve(owner, "bad-route", "on", { route: "summary" })).rejects.toMatchObject({
      code: "22023",
    });
    await expect(reserve(owner, "bad-feature", "on", { features: ["api"] })).rejects.toMatchObject({
      code: "22023",
    });
    await expect(reserve(owner, "bad-cap", "on", { cap: 501 })).rejects.toMatchObject({
      code: "22023",
    });
    await expect(
      asRole("authenticated", () =>
        db.query(
          "select public.reserve_membership_ai_request($1::uuid,'x',$2,'ask',null,50,'on')",
          [owner, fingerprint],
        ),
      ),
    ).rejects.toBeTruthy();
  });

  it("reports usage with the same limit rule", async () => {
    await fillToday(otherOwner, 3);
    await grant(otherOwner, "pro", "manual", null);
    const usage = (mode: string, cap = 50) =>
      asRole("service_role", () =>
        value<Json>("select public.ai_membership_usage($1::uuid,$2,$3) as value", [
          otherOwner,
          cap,
          mode,
        ]),
      );
    expect(await usage("off")).toEqual({ usedCount: 3, dailyLimit: 50, membership: null });
    expect(await usage("shadow")).toMatchObject({
      dailyLimit: 50,
      membership: { planCode: "pro" },
    });
    expect(await usage("on", 500)).toMatchObject({ usedCount: 3, dailyLimit: 100 });
  });
});

describe("AI token ledger", () => {
  it("accumulates repeated model calls and token-only routes in the UTC total", async () => {
    expect(await reserve(owner, "token-request", "off")).toEqual({ status: "reserved" });
    await asRole("service_role", () =>
      db.query(
        "select public.finish_ai_request($1::uuid,$2,$3::jsonb,$4,$5::bigint,$6::bigint)",
        [owner, "token-request", null, null, 12, 8],
      ),
    );
    await asRole("service_role", () =>
      db.query(
        "select public.finish_ai_request($1::uuid,$2,$3::jsonb,$4,$5::bigint,$6::bigint)",
        [owner, "token-request", null, null, 3, 4],
      ),
    );
    await asRole("service_role", () =>
      db.query(
        "select public.finish_ai_request($1::uuid,$2,$3::jsonb,$4,$5::bigint,$6::bigint)",
        [owner, "token-request", JSON.stringify({ answer: "saved" }), null, 5, 6],
      ),
    );
    await asRole("service_role", () =>
      db.query("select public.record_ai_token_usage($1::uuid,$2,$3,$4::bigint,$5::bigint)", [
        owner,
        "ocr-request",
        "ocr",
        2,
        3,
      ]),
    );
    expect(
      (
        await db.query(
          "select state,prompt_tokens,completion_tokens from public.ai_requests where request_id='token-request'",
        )
      ).rows,
    ).toEqual([{ state: "completed", prompt_tokens: 20, completion_tokens: 18 }]);
    expect(await value<Json>("select public.ai_token_usage_today($1::uuid) as value", [owner])).toEqual({
      promptTokens: 22,
      completionTokens: 21,
    });
  });

  it("keeps the legacy completion signature and service-role boundary", async () => {
    expect(await reserve(owner, "legacy-finish", "off")).toEqual({ status: "reserved" });
    await asRole("service_role", () =>
      db.query("select public.finish_ai_request($1::uuid,$2,$3::jsonb,$4)", [
        owner,
        "legacy-finish",
        JSON.stringify({ answer: "legacy" }),
        null,
      ]),
    );
    expect(
      (
        await db.query(
          "select state,prompt_tokens,completion_tokens from public.ai_requests where request_id='legacy-finish'",
        )
      ).rows,
    ).toEqual([{ state: "completed", prompt_tokens: 0, completion_tokens: 0 }]);
    await expect(
      asRole("authenticated", () =>
        db.query("select public.record_ai_token_usage($1::uuid,$2,$3,1,1)", [
          owner,
          "forbidden",
          "ocr",
        ]),
      ),
    ).rejects.toBeTruthy();
  });
});

describe("learning space limit in save_workspace", () => {
  it("refuses only saves that add active spaces beyond the plan limit", async () => {
    const two = [
      { id: "space-a", archived: false },
      { id: "space-b", archived: false },
    ];
    // Saved while the limit was the current maximum.
    let revision = await saveWorkspace(spaceOwner, workspaceWithSpaces(two), 0);
    await db.exec(
      "UPDATE public.membership_plans SET learning_space_limit = 1 WHERE code = 'free'",
    );

    // Downgraded accounts keep saving existing work.
    revision = await saveWorkspace(spaceOwner, workspaceWithSpaces(two), revision);

    await expect(
      saveWorkspace(
        spaceOwner,
        workspaceWithSpaces([...two, { id: "space-c", archived: false }]),
        revision,
      ),
    ).rejects.toMatchObject({ code: "PT403" });

    // Archiving then creating keeps the active count unchanged.
    revision = await saveWorkspace(
      spaceOwner,
      workspaceWithSpaces([
        { id: "space-a", archived: false },
        { id: "space-b", archived: true },
        { id: "space-c", archived: false },
      ]),
      revision,
    );

    // Unarchiving counts as adding an active space.
    await expect(
      saveWorkspace(
        spaceOwner,
        workspaceWithSpaces([
          { id: "space-a", archived: false },
          { id: "space-b", archived: false },
          { id: "space-c", archived: false },
        ]),
        revision,
      ),
    ).rejects.toMatchObject({ code: "PT403" });

    await grant(spaceOwner, "pro", "manual", null);
    await db.exec("UPDATE public.membership_plans SET learning_space_limit = 5 WHERE code = 'pro'");
    await expect(
      saveWorkspace(
        spaceOwner,
        workspaceWithSpaces([
          { id: "space-a", archived: false },
          { id: "space-b", archived: false },
          { id: "space-c", archived: false },
        ]),
        revision,
      ),
    ).resolves.toBe(revision + 1);
  });

  it("checks the first save against the limit and still reports revision conflicts first", async () => {
    await db.exec(
      "UPDATE public.membership_plans SET learning_space_limit = 1 WHERE code = 'free'",
    );
    await expect(
      saveWorkspace(
        otherOwner,
        workspaceWithSpaces([
          { id: "space-a", archived: false },
          { id: "space-b", archived: false },
        ]),
        0,
      ),
    ).rejects.toMatchObject({ code: "PT403" });
    await expect(saveWorkspace(otherOwner, createEmptyWorkspace(), 0)).resolves.toBe(1);
    await expect(
      saveWorkspace(
        otherOwner,
        workspaceWithSpaces([
          { id: "space-a", archived: false },
          { id: "space-b", archived: false },
        ]),
        0,
      ),
    ).rejects.toMatchObject({ code: "PT409" });
  });
});
