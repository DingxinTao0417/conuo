-- A browser may resume the same local import on more than one device.  The
-- workspace snapshot remains the write authority, but parsing one immutable
-- source version needs a server-side fencing token before its result can be
-- committed.  This prevents a delayed browser from publishing stale parsed
-- text over a newer parse or a user cancellation.
begin;

-- This relation intentionally lives in the non-exposed private schema.  A
-- caller can learn about its own lease only through the narrowly scoped RPCs
-- below; neither authenticated sessions nor workers receive table access.
create table conuo_private.import_parse_leases (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  source_id text not null check (source_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  version_id text not null check (version_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  lease_token uuid not null,
  lease_until timestamptz not null,
  -- Kept for diagnostics and returned to the claimant.  Finish always checks
  -- its caller-supplied current CAS revision so unrelated edits remain legal.
  claimed_revision bigint not null check (claimed_revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (owner_id, source_id, version_id)
);
create index import_parse_leases_expiry on conuo_private.import_parse_leases (lease_until);
alter table conuo_private.import_parse_leases enable row level security;
revoke all on table conuo_private.import_parse_leases from public, anon, authenticated, service_role;

comment on table conuo_private.import_parse_leases is
  'Private per-owner import parse fences. Only authenticated owner RPCs may claim, renew, release, or finish.';

-- Keep token input as text at the API boundary so malformed/missing tokens get
-- a controlled 22023 instead of relying on a PostgREST UUID cast error.
create function conuo_private.import_parse_lease_token(p_lease_token text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  if p_lease_token is null or p_lease_token !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'Invalid import parse lease token';
  end if;
  return p_lease_token::uuid;
end;
$$;

-- Return exactly one current source + queue item pair.  This is deliberately
-- stricter than a loose source-ID lookup: a historical-version job or a
-- duplicated pair cannot be leased.
create function conuo_private.import_parse_target(
  p_data jsonb,
  p_source_id text,
  p_version_id text
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_sources jsonb;
  v_jobs jsonb;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object'
    or jsonb_typeof(p_data->'sources') <> 'array'
    or jsonb_typeof(p_data->'importJobs') <> 'array' then
    return null;
  end if;

  select coalesce(jsonb_agg(source.value), '[]'::jsonb) into v_sources
    from jsonb_array_elements(p_data->'sources') source(value)
    where jsonb_typeof(source.value) = 'object'
      and source.value->>'id' = p_source_id
      and source.value->>'versionId' = p_version_id;
  if jsonb_array_length(v_sources) <> 1 then
    return null;
  end if;

  select coalesce(jsonb_agg(job.value), '[]'::jsonb) into v_jobs
    from jsonb_array_elements(p_data->'importJobs') job(value)
    where jsonb_typeof(job.value) = 'object'
      and job.value->>'sourceId' = p_source_id
      and job.value->>'versionId' = p_version_id;
  if jsonb_array_length(v_jobs) <> 1 then
    return null;
  end if;

  return jsonb_build_object('source', v_sources->0, 'job', v_jobs->0);
end;
$$;

create function conuo_private.import_parse_target_is_active(
  p_target jsonb,
  p_source_id text,
  p_version_id text
) returns boolean language sql immutable set search_path = '' as $$
  select coalesce(
    p_target is not null
    and jsonb_typeof(p_target) = 'object'
    and jsonb_typeof(p_target->'source') = 'object'
    and jsonb_typeof(p_target->'job') = 'object'
    and p_target->'source'->>'id' = p_source_id
    and p_target->'source'->>'versionId' = p_version_id
    and p_target->'source' ? 'deletedAt'
    and jsonb_typeof(p_target->'source'->'deletedAt') = 'null'
    and coalesce(p_target->'source'->>'status', '') in ('saved', 'parsing')
    and (p_target->'source'->>'originalMissing' is distinct from 'true')
    and p_target->'job'->>'sourceId' = p_source_id
    and p_target->'job'->>'versionId' = p_version_id
    and p_target->'job'->>'stage' = 'parsing'
    and coalesce(p_target->'job'->>'status', '') in ('queued', 'running')
    and jsonb_typeof(p_target->'job'->'originalSaved') = 'boolean'
    and p_target->'job'->>'originalSaved' = 'true',
    false
  );
$$;

create function conuo_private.assert_active_import_parse_target(
  p_data jsonb,
  p_source_id text,
  p_version_id text
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_target jsonb;
begin
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id) then
    raise exception using errcode = '22023', message = 'Invalid import parse target';
  end if;
  v_target := conuo_private.import_parse_target(p_data, p_source_id, p_version_id);
  if not conuo_private.import_parse_target_is_active(v_target, p_source_id, p_version_id) then
    raise exception using errcode = '40001', message = 'Import parse target unavailable';
  end if;
  return v_target;
end;
$$;

-- A parser may change derived text, chunks, coverage outcome and status, but
-- it never receives authority to replace the immutable original or captured
-- web provenance for the existing source version. Every source field is kept
-- byte-for-byte stable unless it is a parser-controlled outcome field. This
-- preserves optional-field presence too, except that a legacy missing coverage
-- field is treated as the full-document capture scope it always implied.
create function conuo_private.import_parse_source_identity(p_source jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select (p_source - array[
    'status', 'coverage', 'text', 'chunks', 'pageCount', 'parsedPages', 'error', 'updatedAt'
  ]::text[]) || case
    -- Capture scope is retained-material provenance. Parse state and missing
    -- ranges are the only coverage fields a parser may update.
    when p_source ? 'coverage' and jsonb_typeof(p_source->'coverage') = 'object' then
      jsonb_build_object(
        'coverage',
        (p_source->'coverage') - array['parseState', 'unavailablePageRanges']::text[]
      )
    -- Preserve malformed scalar/null values so the comparison below rejects
    -- them with the controlled identity error rather than a jsonb operator error.
    when p_source ? 'coverage' then jsonb_build_object('coverage', p_source->'coverage')
    -- 202609120003 allowed legacy source snapshots without coverage. Their
    -- retained material was necessarily a full capture, so normalize only this
    -- absence for a controlled transition to current full-coverage snapshots.
    else jsonb_build_object('coverage', jsonb_build_object('captureScope', 'full'))
  end;
$$;

-- Source/version identity alone is insufficient because the full workspace
-- snapshot also contains its durable import queue item. A lease may move the
-- parser state, but it cannot replace the task that owns the retained original.
create function conuo_private.import_parse_job_identity(p_job jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select p_job - array[
    'status', 'stage', 'attempt', 'updatedAt', 'error', 'cancelledAt', 'completedAt'
  ]::text[];
$$;

create function conuo_private.assert_import_parse_source_identity_unchanged(
  p_current_data jsonb,
  p_incoming_data jsonb,
  p_source_id text,
  p_version_id text
) returns void language plpgsql immutable set search_path = '' as $$
declare
  v_current_target jsonb;
  v_incoming_target jsonb;
begin
  v_current_target := conuo_private.import_parse_target(
    p_current_data, p_source_id, p_version_id
  );
  v_incoming_target := conuo_private.import_parse_target(
    p_incoming_data, p_source_id, p_version_id
  );
  if v_current_target is null or v_incoming_target is null then
    raise exception using errcode = '40001', message = 'Import parse source identity changed';
  end if;
  if conuo_private.import_parse_source_identity(v_current_target->'source')
    is distinct from conuo_private.import_parse_source_identity(v_incoming_target->'source') then
    raise exception using errcode = '40001', message = 'Import parse source identity changed';
  end if;
  if conuo_private.import_parse_job_identity(v_current_target->'job')
    is distinct from conuo_private.import_parse_job_identity(v_incoming_target->'job') then
    raise exception using errcode = '40001', message = 'Import parse job identity changed';
  end if;
end;
$$;

-- The result snapshot is permitted to change the fenced pair only into one of
-- the terminal states used by the import coordinator.  Cancellation is a
-- separate owner-authorized state transition below, so it cannot be smuggled
-- through a parser finish.
create function conuo_private.assert_finished_import_parse_target(
  p_data jsonb,
  p_source_id text,
  p_version_id text
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_target jsonb;
  v_source jsonb;
  v_job jsonb;
begin
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id) then
    raise exception using errcode = '22023', message = 'Invalid import parse target';
  end if;
  v_target := conuo_private.import_parse_target(p_data, p_source_id, p_version_id);
  if v_target is null then
    raise exception using errcode = '40001', message = 'Import parse finish target changed';
  end if;
  v_source := v_target->'source';
  v_job := v_target->'job';
  if not (v_source ? 'deletedAt')
    or jsonb_typeof(v_source->'deletedAt') <> 'null'
    or v_source->>'originalMissing' = 'true'
    or jsonb_typeof(v_job->'originalSaved') <> 'boolean'
    or v_job->>'originalSaved' <> 'true'
    or not (
      (coalesce(v_source->>'status', '') in ('ready', 'partial')
        and v_job->>'status' = 'completed'
        and v_job->>'stage' = 'indexing')
      or (
        v_source->>'status' = 'failed'
        and v_job->>'status' = 'failed'
        and v_job->>'stage' = 'parsing'
      )
    ) then
    raise exception using errcode = '40001', message = 'Invalid import parse finish snapshot';
  end if;
  return v_target;
end;
$$;

-- Cancellation is a controlled owner-authorized transition. It clears the
-- provisional parser output and leaves the retained original ready for a later
-- retry; it never accepts a terminal parse result in disguise.
create function conuo_private.assert_cancelled_import_parse_target(
  p_data jsonb,
  p_source_id text,
  p_version_id text
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_target jsonb;
  v_source jsonb;
  v_job jsonb;
begin
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id) then
    raise exception using errcode = '22023', message = 'Invalid import parse target';
  end if;
  v_target := conuo_private.import_parse_target(p_data, p_source_id, p_version_id);
  if v_target is null then
    raise exception using errcode = '40001', message = 'Import parse cancellation target changed';
  end if;
  v_source := v_target->'source';
  v_job := v_target->'job';
  if not (v_source ? 'deletedAt')
    or jsonb_typeof(v_source->'deletedAt') is distinct from 'null'
    or v_source->>'originalMissing' = 'true'
    or v_source->>'status' is distinct from 'saved'
    or v_source->'text' is distinct from '""'::jsonb
    or v_source->'chunks' is distinct from '[]'::jsonb
    or v_source->'coverage' is distinct from
      '{"captureScope":"full","parseState":"pending"}'::jsonb
    or v_job->>'status' is distinct from 'cancelled'
    or v_job->>'stage' is distinct from 'parsing'
    or jsonb_typeof(v_job->'originalSaved') is distinct from 'boolean'
    or v_job->>'originalSaved' <> 'true' then
    raise exception using errcode = '40001', message = 'Invalid import parse cancellation snapshot';
  end if;
  return v_target;
end;
$$;

-- A retry may only originate from a terminal parser failure or a durable user
-- cancellation. Both states preserve the exact source/version and original.
create function conuo_private.assert_retryable_import_parse_target(
  p_data jsonb,
  p_source_id text,
  p_version_id text
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_target jsonb;
  v_source jsonb;
  v_job jsonb;
begin
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id) then
    raise exception using errcode = '22023', message = 'Invalid import parse target';
  end if;
  v_target := conuo_private.import_parse_target(p_data, p_source_id, p_version_id);
  if v_target is null then
    raise exception using errcode = '40001', message = 'Import parse retry target changed';
  end if;
  v_source := v_target->'source';
  v_job := v_target->'job';
  if not (v_source ? 'deletedAt')
    or jsonb_typeof(v_source->'deletedAt') is distinct from 'null'
    or v_source->>'originalMissing' = 'true'
    or v_job->>'stage' is distinct from 'parsing'
    or jsonb_typeof(v_job->'originalSaved') is distinct from 'boolean'
    or v_job->>'originalSaved' <> 'true'
    or not (
      (v_source->>'status' = 'failed' and v_job->>'status' = 'failed')
      or (v_source->>'status' = 'saved' and v_job->>'status' = 'cancelled')
    ) then
    raise exception using errcode = '40001', message = 'Import parse target is not retryable';
  end if;
  return v_target;
end;
$$;

-- The retry snapshot has the same deliberately blank parser payload as an
-- initial parse, but may begin queued or already running after a handoff.
create function conuo_private.assert_retried_import_parse_target(
  p_data jsonb,
  p_source_id text,
  p_version_id text
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_target jsonb;
  v_source jsonb;
  v_job jsonb;
begin
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id) then
    raise exception using errcode = '22023', message = 'Invalid import parse target';
  end if;
  v_target := conuo_private.import_parse_target(p_data, p_source_id, p_version_id);
  if v_target is null then
    raise exception using errcode = '40001', message = 'Import parse retry target changed';
  end if;
  v_source := v_target->'source';
  v_job := v_target->'job';
  if not (v_source ? 'deletedAt')
    or jsonb_typeof(v_source->'deletedAt') is distinct from 'null'
    or v_source->>'originalMissing' = 'true'
    or v_source->>'status' is distinct from 'parsing'
    or v_source->'text' is distinct from '""'::jsonb
    or v_source->'chunks' is distinct from '[]'::jsonb
    or v_source->'coverage' is distinct from
      '{"captureScope":"full","parseState":"pending"}'::jsonb
    or v_job->>'stage' is distinct from 'parsing'
    or coalesce(v_job->>'status', '') not in ('queued', 'running')
    or jsonb_typeof(v_job->'originalSaved') is distinct from 'boolean'
    or v_job->>'originalSaved' <> 'true' then
    raise exception using errcode = '40001', message = 'Invalid import parse retry snapshot';
  end if;
  return v_target;
end;
$$;

-- All public snapshot writers reuse the final save_workspace payload and
-- tombstone checks.  Keep this exact validation boundary separate from parse
-- state checks so ordinary unrelated workspace edits retain their behavior.
create function conuo_private.validate_workspace_payload(p_owner uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_owner is null
    or p_data is null
    or jsonb_typeof(p_data) <> 'object'
    or p_data->>'schemaVersion' is distinct from '1'
    or jsonb_typeof(p_data->'spaces') is distinct from 'array'
    or jsonb_typeof(p_data->'sources') is distinct from 'array'
    or jsonb_typeof(p_data->'notes') is distinct from 'array'
    or jsonb_typeof(p_data->'annotations') is distinct from 'array'
    or jsonb_typeof(p_data->'conversations') is distinct from 'array'
    or jsonb_typeof(p_data->'aiEnabled') is distinct from 'boolean'
    or octet_length(p_data::text) > 3145728 then
    raise exception using errcode = '22023', message = 'Invalid workspace payload';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_data->'sources') source(value)
      join public.source_tombstones tombstone
        on tombstone.owner_id = p_owner and tombstone.source_id = source.value->>'id'
  ) then
    raise exception using errcode = '40001', message = 'Source was permanently deleted';
  end if;
end;
$$;

-- A normal save can proceed while another device parses a source, provided it
-- carries the exact same source and matching import-job JSON.  This makes note
-- edits and other independent work safe, while a stale parser cannot use the
-- old general save RPC to replace the fenced pair.
create function conuo_private.assert_other_import_parse_leases_unchanged(
  p_owner uuid,
  p_current_data jsonb,
  p_incoming_data jsonb,
  p_allowed_source_id text,
  p_allowed_version_id text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_lease conuo_private.import_parse_leases%rowtype;
  v_current_target jsonb;
  v_incoming_target jsonb;
begin
  delete from conuo_private.import_parse_leases lease
    where lease.owner_id = p_owner and lease.lease_until <= clock_timestamp();

  for v_lease in
    select *
      from conuo_private.import_parse_leases lease
      where lease.owner_id = p_owner and lease.lease_until > clock_timestamp()
      for update
  loop
    if p_allowed_source_id is not null and p_allowed_version_id is not null
      and v_lease.source_id = p_allowed_source_id
      and v_lease.version_id = p_allowed_version_id then
      continue;
    end if;
    v_current_target := conuo_private.import_parse_target(
      p_current_data, v_lease.source_id, v_lease.version_id
    );
    -- A privileged cancellation/purge can make a lease stale without going
    -- through save_workspace.  Do not let that old record block later work.
    if not conuo_private.import_parse_target_is_active(
      v_current_target, v_lease.source_id, v_lease.version_id
    ) then
      delete from conuo_private.import_parse_leases lease
        where lease.owner_id = v_lease.owner_id
          and lease.source_id = v_lease.source_id
          and lease.version_id = v_lease.version_id
          and lease.lease_token = v_lease.lease_token;
      continue;
    end if;

    v_incoming_target := conuo_private.import_parse_target(
      p_incoming_data, v_lease.source_id, v_lease.version_id
    );
    if v_incoming_target is distinct from v_current_target then
      raise exception using errcode = '40001', message = 'Import parse lease protects the current source';
    end if;
  end loop;
end;
$$;

create function conuo_private.assert_import_parse_leases_unchanged(
  p_owner uuid,
  p_current_data jsonb,
  p_incoming_data jsonb
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform conuo_private.assert_other_import_parse_leases_unchanged(
    p_owner, p_current_data, p_incoming_data, null, null
  );
end;
$$;

create function conuo_private.lock_import_parse_lease(
  p_owner uuid,
  p_source_id text,
  p_version_id text,
  p_lease_token text
) returns conuo_private.import_parse_leases
language plpgsql security definer set search_path = '' as $$
declare
  v_token uuid;
  v_lease conuo_private.import_parse_leases%rowtype;
begin
  if p_owner is null or not conuo_private.valid_id(p_source_id)
    or not conuo_private.valid_id(p_version_id) then
    raise exception using errcode = '22023', message = 'Invalid import parse lease';
  end if;
  v_token := conuo_private.import_parse_lease_token(p_lease_token);
  select * into v_lease
    from conuo_private.import_parse_leases lease
    where lease.owner_id = p_owner
      and lease.source_id = p_source_id
      and lease.version_id = p_version_id
    for update;
  if not found
    or v_lease.lease_token is distinct from v_token
    or v_lease.lease_until <= clock_timestamp() then
    raise exception using errcode = '40001', message = 'Import parse lease unavailable';
  end if;
  return v_lease;
end;
$$;

-- The normal source projection enforces immutable source-version manifests.
-- The three tightly fenced parser transitions are the sole path allowed to
-- replace a provisional parsing projection for the same source/version.
create function conuo_private.replace_import_parse_projection(
  p_owner uuid,
  p_source_id text,
  p_version_id text,
  p_expected_revision bigint,
  p_data jsonb
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_revision bigint;
begin
  if p_owner is null or not conuo_private.valid_id(p_source_id)
    or not conuo_private.valid_id(p_version_id) or p_expected_revision is null
    or p_expected_revision < 1 then
    raise exception using errcode = '22023', message = 'Invalid import parse transition';
  end if;

  -- source_current_version is deferred. project_workspace recreates this exact
  -- row (and the normal note trigger has already run) before commit; any later
  -- validation failure rolls this deletion back atomically.
  delete from public.source_versions version_row
    where version_row.owner_id = p_owner
      and version_row.source_id = p_source_id
      and version_row.version_id = p_version_id;

  update public.workspaces workspace
    set data = p_data, revision = workspace.revision + 1, updated_at = clock_timestamp()
    where workspace.owner_id = p_owner and workspace.revision = p_expected_revision
    returning workspace.revision into v_revision;
  if v_revision is null then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  perform conuo_private.project_workspace(p_owner, p_data);
  return v_revision;
end;
$$;

create function public.claim_import_parse(
  p_source_id text,
  p_version_id text,
  p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_lease conuo_private.import_parse_leases%rowtype;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id)
    or p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception using errcode = '22023', message = 'Invalid import parse claim';
  end if;
  perform conuo_private.owner_lock(v_owner);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_owner for update;
  if not found then
    raise exception using errcode = '40001', message = 'Import parse target unavailable';
  end if;
  perform conuo_private.assert_active_import_parse_target(
    v_workspace.data, p_source_id, p_version_id
  );

  delete from conuo_private.import_parse_leases lease
    where lease.owner_id = v_owner
      and lease.source_id = p_source_id
      and lease.version_id = p_version_id
      and lease.lease_until <= clock_timestamp();
  insert into conuo_private.import_parse_leases(
    owner_id, source_id, version_id, lease_token, lease_until, claimed_revision
  ) values (
    v_owner,
    p_source_id,
    p_version_id,
    gen_random_uuid(),
    clock_timestamp() + make_interval(secs => p_lease_seconds),
    v_workspace.revision
  ) on conflict (owner_id, source_id, version_id) do nothing
  returning * into v_lease;

  if not found then
    select * into v_lease
      from conuo_private.import_parse_leases lease
      where lease.owner_id = v_owner
        and lease.source_id = p_source_id
        and lease.version_id = p_version_id;
    return jsonb_build_object(
      'status', 'busy',
      'sourceId', p_source_id,
      'versionId', p_version_id,
      'workspaceRevision', v_workspace.revision,
      'leaseUntil', v_lease.lease_until
    );
  end if;
  return jsonb_build_object(
    'status', 'claimed',
    'sourceId', p_source_id,
    'versionId', p_version_id,
    'leaseToken', v_lease.lease_token,
    'leaseUntil', v_lease.lease_until,
    'workspaceRevision', v_workspace.revision
  );
end;
$$;

create function public.heartbeat_import_parse(
  p_source_id text,
  p_version_id text,
  p_lease_token text,
  p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_lease conuo_private.import_parse_leases%rowtype;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception using errcode = '22023', message = 'Invalid import parse lease duration';
  end if;
  perform conuo_private.owner_lock(v_owner);
  v_lease := conuo_private.lock_import_parse_lease(
    v_owner, p_source_id, p_version_id, p_lease_token
  );
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_owner for update;
  if not found then
    raise exception using errcode = '40001', message = 'Import parse target unavailable';
  end if;
  perform conuo_private.assert_active_import_parse_target(
    v_workspace.data, p_source_id, p_version_id
  );
  update conuo_private.import_parse_leases lease
    set lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        updated_at = clock_timestamp()
    where lease.owner_id = v_lease.owner_id
      and lease.source_id = v_lease.source_id
      and lease.version_id = v_lease.version_id
      and lease.lease_token = v_lease.lease_token
    returning * into v_lease;
  return jsonb_build_object('leaseUntil', v_lease.lease_until);
end;
$$;

create function public.release_import_parse(
  p_source_id text,
  p_version_id text,
  p_lease_token text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_token uuid;
  v_lease conuo_private.import_parse_leases%rowtype;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id) then
    raise exception using errcode = '22023', message = 'Invalid import parse lease';
  end if;
  perform conuo_private.owner_lock(v_owner);
  v_token := conuo_private.import_parse_lease_token(p_lease_token);
  select * into v_lease
    from conuo_private.import_parse_leases lease
    where lease.owner_id = v_owner
      and lease.source_id = p_source_id
      and lease.version_id = p_version_id
    for update;
  if not found then
    return jsonb_build_object('released', true, 'alreadyReleased', true);
  end if;
  if v_lease.lease_until <= clock_timestamp() then
    delete from conuo_private.import_parse_leases lease
      where lease.owner_id = v_lease.owner_id
        and lease.source_id = v_lease.source_id
        and lease.version_id = v_lease.version_id
        and lease.lease_token = v_lease.lease_token;
    return jsonb_build_object('released', true, 'alreadyReleased', true);
  end if;
  if v_lease.lease_token is distinct from v_token then
    raise exception using errcode = '40001', message = 'Import parse lease unavailable';
  end if;
  delete from conuo_private.import_parse_leases lease
    where lease.owner_id = v_lease.owner_id
      and lease.source_id = v_lease.source_id
      and lease.version_id = v_lease.version_id
      and lease.lease_token = v_lease.lease_token;
  return jsonb_build_object('released', true, 'alreadyReleased', false);
end;
$$;

create function public.finish_import_parse(
  p_source_id text,
  p_version_id text,
  p_lease_token text,
  p_expected_revision bigint,
  p_data jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_lease conuo_private.import_parse_leases%rowtype;
  v_revision bigint;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception using errcode = '22023', message = 'Invalid import parse finish revision';
  end if;
  perform conuo_private.owner_lock(v_owner);
  v_lease := conuo_private.lock_import_parse_lease(
    v_owner, p_source_id, p_version_id, p_lease_token
  );
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_owner for update;
  if not found then
    raise exception using errcode = '40001', message = 'Import parse target unavailable';
  end if;
  perform conuo_private.assert_active_import_parse_target(
    v_workspace.data, p_source_id, p_version_id
  );
  if v_workspace.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  perform conuo_private.validate_workspace_payload(v_owner, p_data);
  perform conuo_private.assert_finished_import_parse_target(p_data, p_source_id, p_version_id);
  perform conuo_private.assert_import_parse_source_identity_unchanged(
    v_workspace.data, p_data, p_source_id, p_version_id
  );
  -- A full finish snapshot may only modify the pair owned by this exact token;
  -- other devices' active parse pairs retain the same guard as generic saves.
  perform conuo_private.assert_other_import_parse_leases_unchanged(
    v_owner, v_workspace.data, p_data, p_source_id, p_version_id
  );

  -- The normal source projection and workspace note trigger run inside this
  -- fenced transition; any projection failure rolls the snapshot and lease back.
  v_revision := conuo_private.replace_import_parse_projection(
    v_owner, p_source_id, p_version_id, p_expected_revision, p_data
  );
  delete from conuo_private.import_parse_leases lease
    where lease.owner_id = v_lease.owner_id
      and lease.source_id = v_lease.source_id
      and lease.version_id = v_lease.version_id
      and lease.lease_token = v_lease.lease_token;
  return jsonb_build_object('revision', v_revision);
end;
$$;

-- Any authenticated device for the owner may cancel active work. It does not
-- need the claimant token: owner/workspace serialization makes cancellation and
-- finish mutually exclusive, and removal of every pair lease fences a late parser.
create function public.cancel_import_parse(
  p_source_id text,
  p_version_id text,
  p_expected_revision bigint,
  p_data jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_revision bigint;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id)
    or p_expected_revision is null or p_expected_revision < 1 then
    raise exception using errcode = '22023', message = 'Invalid import parse cancellation';
  end if;
  perform conuo_private.owner_lock(v_owner);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_owner for update;
  if not found then
    raise exception using errcode = '40001', message = 'Import parse target unavailable';
  end if;
  perform conuo_private.assert_active_import_parse_target(
    v_workspace.data, p_source_id, p_version_id
  );
  if v_workspace.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  perform conuo_private.validate_workspace_payload(v_owner, p_data);
  perform conuo_private.assert_cancelled_import_parse_target(p_data, p_source_id, p_version_id);
  perform conuo_private.assert_import_parse_source_identity_unchanged(
    v_workspace.data, p_data, p_source_id, p_version_id
  );
  -- The cancelling pair is deliberately allowed to change; all other live
  -- parser pairs remain byte-for-byte equal in this full workspace snapshot.
  perform conuo_private.assert_other_import_parse_leases_unchanged(
    v_owner, v_workspace.data, p_data, p_source_id, p_version_id
  );
  v_revision := conuo_private.replace_import_parse_projection(
    v_owner, p_source_id, p_version_id, p_expected_revision, p_data
  );
  -- This is an owner-authorized cancellation, so remove any holder's exact
  -- token only after the terminal snapshot is safely projected.
  delete from conuo_private.import_parse_leases lease
    where lease.owner_id = v_owner
      and lease.source_id = p_source_id
      and lease.version_id = p_version_id;
  return jsonb_build_object('revision', v_revision);
end;
$$;

-- Retrying starts from a finished/cancelled pair, so there is no claimant token
-- to present. The owner lock and revision CAS serialize the new active snapshot
-- with an arriving cancellation, finish, or generic unrelated save.
create function public.retry_import_parse(
  p_source_id text,
  p_version_id text,
  p_expected_revision bigint,
  p_data jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_revision bigint;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id)
    or p_expected_revision is null or p_expected_revision < 1 then
    raise exception using errcode = '22023', message = 'Invalid import parse retry';
  end if;
  perform conuo_private.owner_lock(v_owner);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_owner for update;
  if not found then
    raise exception using errcode = '40001', message = 'Import parse target unavailable';
  end if;
  perform conuo_private.assert_retryable_import_parse_target(
    v_workspace.data, p_source_id, p_version_id
  );
  if v_workspace.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  perform conuo_private.validate_workspace_payload(v_owner, p_data);
  perform conuo_private.assert_retried_import_parse_target(p_data, p_source_id, p_version_id);
  perform conuo_private.assert_import_parse_source_identity_unchanged(
    v_workspace.data, p_data, p_source_id, p_version_id
  );
  -- A terminal pair has no valid live lease. This also reaps a stale target
  -- lease before the source becomes active again and protects every other one.
  perform conuo_private.assert_import_parse_leases_unchanged(
    v_owner, v_workspace.data, p_data
  );
  v_revision := conuo_private.replace_import_parse_projection(
    v_owner, p_source_id, p_version_id, p_expected_revision, p_data
  );
  delete from conuo_private.import_parse_leases lease
    where lease.owner_id = v_owner
      and lease.source_id = p_source_id
      and lease.version_id = p_version_id;
  return jsonb_build_object('revision', v_revision);
end;
$$;

-- Preserve the existing snapshot writer's input validation, owner deletion
-- fence, tombstone behavior, compare-and-swap semantics, and projections.
-- The only new restriction is that a live parse pair itself cannot be changed
-- through this generic writer.
create or replace function public.save_workspace(p_data jsonb, p_expected_revision bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_revision bigint;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_expected_revision is null or p_expected_revision < 0
    or p_data is null
    or jsonb_typeof(p_data) <> 'object'
    or p_data->>'schemaVersion' is distinct from '1'
    or jsonb_typeof(p_data->'spaces') is distinct from 'array'
    or jsonb_typeof(p_data->'sources') is distinct from 'array'
    or jsonb_typeof(p_data->'notes') is distinct from 'array'
    or jsonb_typeof(p_data->'annotations') is distinct from 'array'
    or jsonb_typeof(p_data->'conversations') is distinct from 'array'
    or jsonb_typeof(p_data->'aiEnabled') is distinct from 'boolean'
    or octet_length(p_data::text) > 3145728 then
    raise exception using errcode = '22023', message = 'Invalid workspace payload';
  end if;
  perform conuo_private.owner_lock(v_owner);
  perform conuo_private.validate_workspace_payload(v_owner, p_data);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_owner for update;

  if p_expected_revision = 0 then
    if found then
      raise exception using errcode = '40001', message = 'Workspace revision conflict';
    end if;
    insert into public.workspaces(owner_id, data, revision)
      values (v_owner, p_data, 1)
      returning revision into v_revision;
  else
    if not found or v_workspace.revision <> p_expected_revision then
      raise exception using errcode = '40001', message = 'Workspace revision conflict';
    end if;
    perform conuo_private.assert_import_parse_leases_unchanged(
      v_owner, v_workspace.data, p_data
    );
    update public.workspaces workspace
      set data = p_data, revision = workspace.revision + 1, updated_at = now()
      where workspace.owner_id = v_owner and workspace.revision = p_expected_revision
      returning workspace.revision into v_revision;
  end if;

  if v_revision is null then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  perform conuo_private.project_workspace(v_owner, p_data);
  return v_revision;
end;
$$;

revoke all on function conuo_private.import_parse_lease_token(text),
  conuo_private.import_parse_target(jsonb,text,text),
  conuo_private.import_parse_target_is_active(jsonb,text,text),
  conuo_private.assert_active_import_parse_target(jsonb,text,text),
  conuo_private.import_parse_source_identity(jsonb),
  conuo_private.import_parse_job_identity(jsonb),
  conuo_private.assert_import_parse_source_identity_unchanged(jsonb,jsonb,text,text),
  conuo_private.assert_finished_import_parse_target(jsonb,text,text),
  conuo_private.assert_cancelled_import_parse_target(jsonb,text,text),
  conuo_private.assert_retryable_import_parse_target(jsonb,text,text),
  conuo_private.assert_retried_import_parse_target(jsonb,text,text),
  conuo_private.validate_workspace_payload(uuid,jsonb),
  conuo_private.assert_other_import_parse_leases_unchanged(uuid,jsonb,jsonb,text,text),
  conuo_private.assert_import_parse_leases_unchanged(uuid,jsonb,jsonb),
  conuo_private.lock_import_parse_lease(uuid,text,text,text),
  conuo_private.replace_import_parse_projection(uuid,text,text,bigint,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_import_parse(text,text,integer),
  public.heartbeat_import_parse(text,text,text,integer),
  public.release_import_parse(text,text,text),
  public.finish_import_parse(text,text,text,bigint,jsonb),
  public.cancel_import_parse(text,text,bigint,jsonb),
  public.retry_import_parse(text,text,bigint,jsonb)
  from public, anon, service_role;
grant execute on function public.claim_import_parse(text,text,integer),
  public.heartbeat_import_parse(text,text,text,integer),
  public.release_import_parse(text,text,text),
  public.finish_import_parse(text,text,text,bigint,jsonb),
  public.cancel_import_parse(text,text,bigint,jsonb),
  public.retry_import_parse(text,text,bigint,jsonb)
  to authenticated;
revoke all on function public.save_workspace(jsonb,bigint) from public, anon, service_role;
grant execute on function public.save_workspace(jsonb,bigint) to authenticated;

commit;
