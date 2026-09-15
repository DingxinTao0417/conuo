-- Durable account-deletion protocol. This migration never calls Supabase Auth Admin
-- or Storage. A privileged application worker performs those external operations only
-- after the fenced outbox functions below allow it.
begin;

create table public.account_deletions (
  deletion_id uuid primary key,
  -- This intentionally has no FK to auth.users or workspaces: Auth deletion cascades
  -- application data while this audit/outbox record must survive that cascade.
  owner_id uuid not null unique,
  state text not null check (state in (
    'storage_pending', 'storage_processing', 'ready_for_auth_deletion',
    'auth_deletion_processing', 'failed', 'completed'
  )),
  requested_at timestamptz not null default clock_timestamp(),
  storage_completed_at timestamptz,
  auth_attempts integer not null default 0 check (auth_attempts between 0 and 5),
  auth_worker_id text,
  auth_lease_token uuid,
  auth_lease_until timestamptz,
  auth_next_attempt_at timestamptz not null default clock_timestamp(),
  last_error text,
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint account_deletions_auth_lease_state check (
    (state = 'auth_deletion_processing' and auth_worker_id is not null
      and auth_lease_token is not null and auth_lease_until is not null and completed_at is null)
    or (state <> 'auth_deletion_processing' and auth_worker_id is null
      and auth_lease_token is null and auth_lease_until is null)
  ),
  constraint account_deletions_completed_state check ((state = 'completed') = (completed_at is not null)),
  constraint account_deletions_worker_id check (
    auth_worker_id is null or conuo_private.valid_id(auth_worker_id)
  )
);

create table public.account_deletion_objects (
  deletion_id uuid not null references public.account_deletions(deletion_id) on delete cascade,
  bucket_id text not null check (length(bucket_id) between 1 and 100),
  storage_path text not null check (length(storage_path) between 1 and 2048),
  state text not null default 'pending' check (state in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  worker_id text,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  primary key (deletion_id, bucket_id, storage_path),
  constraint account_deletion_objects_worker_id check (
    worker_id is null or conuo_private.valid_id(worker_id)
  ),
  constraint account_deletion_objects_lease_state check (
    (state = 'pending' and worker_id is null and lease_token is null and lease_until is null and completed_at is null)
    or (state = 'processing' and worker_id is not null and lease_token is not null and lease_until is not null and completed_at is null)
    or (state = 'completed' and worker_id is null and lease_token is null and lease_until is null and completed_at is not null)
    or (state = 'failed' and worker_id is null and lease_token is null and lease_until is null and completed_at is null)
  )
);

create index account_deletion_objects_dispatch on public.account_deletion_objects
  (next_attempt_at, lease_until, created_at, deletion_id, bucket_id, storage_path)
  where state in ('pending', 'processing');
create index account_deletions_auth_dispatch on public.account_deletions
  (auth_next_attempt_at, auth_lease_until, requested_at, deletion_id)
  where state in ('ready_for_auth_deletion', 'auth_deletion_processing');

alter table public.account_deletions enable row level security;
alter table public.account_deletion_objects enable row level security;
revoke all on table public.account_deletions, public.account_deletion_objects
  from public, anon, authenticated, service_role;

create function conuo_private.account_deletion_blocked(p_owner uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_owner is not null and exists (
    select 1 from public.account_deletions deletion where deletion.owner_id = p_owner
  );
$$;

create function conuo_private.assert_account_access(p_owner uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if conuo_private.account_deletion_blocked(p_owner) then
    raise exception using errcode = '42501', message = 'Account deletion in progress';
  end if;
end;
$$;

-- No argument means a client cannot probe another account's deletion state. A record
-- remains a deny record even after completion, preventing accidental UUID reuse.
create function public.account_deletion_access_allowed()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and not conuo_private.account_deletion_blocked(auth.uid());
$$;

create function public.account_deletion_access_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_state text;
begin
  if v_owner is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  select deletion.state into v_state from public.account_deletions deletion where deletion.owner_id = v_owner;
  return jsonb_build_object('allowed', v_state is null, 'state', v_state);
end;
$$;

drop policy if exists "Read own workspace" on public.workspaces;
create policy "Read own workspace" on public.workspaces for select to authenticated
  using (owner_id = (select auth.uid()) and public.account_deletion_access_allowed());

-- Restrictive applies alongside every existing permissive Storage policy. It therefore
-- blocks an in-progress account across all buckets, including any future bucket policy.
-- Hosted Supabase owns storage.objects as supabase_storage_admin and has its RLS
-- enabled already, so this migration must only manage policies rather than ALTER the
-- platform-owned relation.
drop policy if exists "Block account deletion storage" on storage.objects;
create policy "Block account deletion storage" on storage.objects as restrictive for all to authenticated
  using (public.account_deletion_access_allowed())
  with check (public.account_deletion_access_allowed());
drop policy if exists "Read own originals" on storage.objects;
drop policy if exists "Upload own originals" on storage.objects;
drop policy if exists "Delete own originals" on storage.objects;
create policy "Read own originals" on storage.objects for select to authenticated
  using (bucket_id = 'originals' and (storage.foldername(name))[1] = (select auth.uid()::text)
    and public.account_deletion_access_allowed());
create policy "Upload own originals" on storage.objects for insert to authenticated
  with check (bucket_id = 'originals' and (storage.foldername(name))[1] = (select auth.uid()::text)
    and public.account_deletion_access_allowed());
create policy "Delete own originals" on storage.objects for delete to authenticated
  using (bucket_id = 'originals' and (storage.foldername(name))[1] = (select auth.uid()::text)
    and public.account_deletion_access_allowed());

-- Existing browser-facing workspace functions funnel through these two helpers. This
-- prevents a still-valid JWT from reading chunks, mutating a snapshot, or starting a
-- source purge after its account was queued for deletion.
create or replace function conuo_private.owner_lock(p_owner uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform conuo_private.assert_account_access(p_owner);
  perform pg_advisory_xact_lock(hashtextextended('conuo:source:' || p_owner::text, 0));
end;
$$;

create or replace function conuo_private.validate_search(
  p_owner uuid,
  p_scope text,
  p_source_ids text[],
  p_limit integer
) returns void language plpgsql stable set search_path = '' as $$
begin
  perform conuo_private.assert_account_access(p_owner);
  if p_scope is null or (p_scope <> '*' and not conuo_private.valid_id(p_scope))
    or p_limit is null or p_limit not between 1 and 100
    or (p_source_ids is not null and (cardinality(p_source_ids) > 5000 or exists (
      select 1 from unnest(p_source_ids) source_id where not conuo_private.valid_id(source_id)
    ))) then
    raise exception using errcode = '22023', message = 'Invalid retrieval scope';
  end if;
  if p_scope not in ('*', 'inbox') and not exists (
    select 1 from public.workspaces workspace,
      jsonb_array_elements(workspace.data->'spaces') space
    where workspace.owner_id = p_owner and space->>'id' = p_scope and space->>'archived' = 'false'
  ) then
    raise exception using errcode = '22023', message = 'Library unavailable';
  end if;
end;
$$;

create or replace function public.preview_source_purge(p_source_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  perform conuo_private.assert_account_access(v_owner);
  return conuo_private.source_purge_preview(v_owner, p_source_id);
end;
$$;

-- A count-only user preview. It purposely contains no canonical path, note body,
-- conversation body, title, or source identifier. It remains available after a request
-- so settings UI can show the durable queued state instead of guessing.
create function conuo_private.account_deletion_preview(p_owner uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state text;
  v_data jsonb;
  v_sources integer;
  v_versions integer;
  v_current_objects integer;
  v_pending_purge_objects integer;
  v_total_objects integer;
begin
  select deletion.state into v_state
    from public.account_deletions deletion where deletion.owner_id = p_owner;
  select workspace.data into v_data from public.workspaces workspace where workspace.owner_id = p_owner;
  select count(*)::integer into v_sources from public.sources source where source.owner_id = p_owner;
  select count(*)::integer into v_versions from public.source_versions version where version.owner_id = p_owner;
  select count(distinct version.storage_path)::integer into v_current_objects
    from public.source_versions version where version.owner_id = p_owner and version.storage_path is not null;
  select count(distinct object.storage_path)::integer into v_pending_purge_objects
    from public.source_purge_objects object
    join public.source_purges purge on purge.purge_id = object.purge_id
    where purge.owner_id = p_owner and object.state <> 'completed';
  select count(*)::integer into v_total_objects from (
    select 'originals'::text as bucket_id, version.storage_path from public.source_versions version
      where version.owner_id = p_owner and version.storage_path is not null
    union
    select 'originals'::text as bucket_id, object.storage_path from public.source_purge_objects object
      join public.source_purges purge on purge.purge_id = object.purge_id
      where purge.owner_id = p_owner and object.state <> 'completed'
    union
    select object.bucket_id, object.name from storage.objects object
      where (storage.foldername(object.name))[1] = p_owner::text
  ) storage_object;
  return jsonb_build_object(
    'state', v_state,
    'sources', v_sources,
    'versions', v_versions,
    'notes', jsonb_array_length(conuo_private.json_array(v_data->'notes')),
    'conversations', jsonb_array_length(conuo_private.json_array(v_data->'conversations')),
    'annotations', jsonb_array_length(conuo_private.json_array(v_data->'annotations')),
    'spaces', jsonb_array_length(conuo_private.json_array(v_data->'spaces')),
    'currentStorageObjects', v_current_objects,
    'pendingSourcePurgeObjects', v_pending_purge_objects,
    'totalStorageObjects', v_total_objects
  );
end;
$$;

create function public.preview_account_deletion()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  return conuo_private.account_deletion_preview(v_owner);
end;
$$;

-- Re-observes storage.objects inside the same database transaction as the account row.
-- A conflict with a completed path reopens it, which seals an upload/delete race where a
-- path appeared after initial preparation but before the Auth deletion fence.
create function conuo_private.capture_account_deletion_storage(
  p_deletion_id uuid,
  p_owner_id uuid
) returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_deletion_id is null or p_owner_id is null then
    raise exception using errcode = '22023', message = 'Invalid account deletion capture';
  end if;
  insert into public.account_deletion_objects(deletion_id, bucket_id, storage_path)
    select p_deletion_id, object.bucket_id, object.name
    from storage.objects object
    where (storage.foldername(object.name))[1] = p_owner_id::text
      and length(object.name) between 1 and 2048
      and length(object.bucket_id) between 1 and 100
    on conflict (deletion_id, bucket_id, storage_path) do update
      set state = 'pending', attempts = 0, worker_id = null, lease_token = null, lease_until = null,
          next_attempt_at = clock_timestamp(), last_error = null, completed_at = null,
          updated_at = clock_timestamp()
      where public.account_deletion_objects.state = 'completed';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function conuo_private.refresh_account_deletion_state(p_deletion_id uuid)
returns public.account_deletions language plpgsql set search_path = '' as $$
declare
  v_deletion public.account_deletions%rowtype;
  v_total integer;
  v_completed integer;
  v_processing integer;
  v_failed integer;
  v_state text;
  v_error text;
begin
  select * into v_deletion from public.account_deletions deletion
    where deletion.deletion_id = p_deletion_id for update;
  if not found then raise exception using errcode = '40001', message = 'Account deletion unavailable'; end if;
  if v_deletion.state in ('completed', 'auth_deletion_processing') then return v_deletion; end if;
  select count(*)::integer,
    count(*) filter (where object.state = 'completed')::integer,
    count(*) filter (where object.state = 'processing')::integer,
    count(*) filter (where object.state = 'failed')::integer
    into v_total, v_completed, v_processing, v_failed
    from public.account_deletion_objects object where object.deletion_id = p_deletion_id;
  v_state := case
    when v_failed > 0 then 'failed'
    when v_total = v_completed then 'ready_for_auth_deletion'
    when v_processing > 0 then 'storage_processing'
    else 'storage_pending'
  end;
  if v_state = 'failed' then
    select object.last_error into v_error from public.account_deletion_objects object
      where object.deletion_id = p_deletion_id and object.state = 'failed'
      order by object.updated_at desc, object.bucket_id, object.storage_path limit 1;
  end if;
  update public.account_deletions deletion set
    state = v_state,
    storage_completed_at = case when v_state = 'ready_for_auth_deletion'
      then coalesce(deletion.storage_completed_at, clock_timestamp()) else null end,
    last_error = case when v_state = 'failed' then v_error else null end,
    updated_at = clock_timestamp()
    where deletion.deletion_id = p_deletion_id returning * into v_deletion;
  return v_deletion;
end;
$$;

-- Service role creates exactly one request per Auth UUID. The owner lock serializes
-- snapshot/source projection, and the external Storage recheck in the Auth claim seals
-- any in-flight upload that committed after this first capture.
create function public.prepare_account_deletion(p_owner_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_deletion public.account_deletions%rowtype; v_count integer; v_purge_id uuid;
begin
  if p_owner_id is null then raise exception using errcode = '22023', message = 'Invalid account deletion owner'; end if;
  perform pg_advisory_xact_lock(hashtextextended('conuo:source:' || p_owner_id::text, 0));
  select * into v_deletion from public.account_deletions deletion
    where deletion.owner_id = p_owner_id for update;
  if found then
    select count(*)::integer into v_count from public.account_deletion_objects object
      where object.deletion_id = v_deletion.deletion_id;
    return jsonb_build_object('deletionId', v_deletion.deletion_id, 'state', v_deletion.state,
      'storageObjects', v_count, 'readyForAuthDeletion', v_deletion.state = 'ready_for_auth_deletion');
  end if;
  if not exists (select 1 from auth.users user_row where user_row.id = p_owner_id) then
    raise exception using errcode = '22023', message = 'Account unavailable for deletion';
  end if;
  if exists (
    select 1 from public.source_versions version where version.owner_id = p_owner_id
      and version.storage_path is not null
      and (version.storage_path not like p_owner_id::text || '/%' or length(version.storage_path) > 2048)
  ) or exists (
    select 1 from public.source_purge_objects object join public.source_purges purge on purge.purge_id = object.purge_id
      where purge.owner_id = p_owner_id and object.state <> 'completed'
      and (object.storage_path not like p_owner_id::text || '/%' or length(object.storage_path) > 2048)
  ) then
    raise exception using errcode = 'P0001', message = 'Account deletion path integrity failed';
  end if;
  insert into public.account_deletions(deletion_id, owner_id, state)
    values (gen_random_uuid(), p_owner_id, 'storage_pending') returning * into v_deletion;
  insert into public.account_deletion_objects(deletion_id, bucket_id, storage_path)
    select v_deletion.deletion_id, 'originals', path.storage_path from (
      select distinct version.storage_path from public.source_versions version
        where version.owner_id = p_owner_id and version.storage_path is not null
      union
      select distinct object.storage_path from public.source_purge_objects object
        join public.source_purges purge on purge.purge_id = object.purge_id
        where purge.owner_id = p_owner_id and object.state <> 'completed'
    ) path order by path.storage_path;
  perform conuo_private.capture_account_deletion_storage(v_deletion.deletion_id, p_owner_id);
  -- Account cleanup now owns every unfinished source-purge path copied above. Marking
  -- those old rows terminal prevents a second worker from claiming them; an already
  -- leased source worker is fenced by its stale completion token and Storage removal is
  -- handled idempotently by the account queue.
  update public.source_purge_objects object set state = 'failed', worker_id = null,
    lease_token = null, lease_until = null, last_error = 'ACCOUNT_DELETION_OWNED',
    updated_at = clock_timestamp()
    from public.source_purges purge
    where purge.purge_id = object.purge_id and purge.owner_id = p_owner_id
      and object.state in ('pending', 'processing');
  for v_purge_id in
    select distinct object.purge_id from public.source_purge_objects object
    join public.source_purges purge on purge.purge_id = object.purge_id
    where purge.owner_id = p_owner_id and object.last_error = 'ACCOUNT_DELETION_OWNED'
  loop
    perform conuo_private.refresh_source_purge_state(v_purge_id);
  end loop;
  v_deletion := conuo_private.refresh_account_deletion_state(v_deletion.deletion_id);
  select count(*)::integer into v_count from public.account_deletion_objects object
    where object.deletion_id = v_deletion.deletion_id;
  return jsonb_build_object('deletionId', v_deletion.deletion_id, 'state', v_deletion.state,
    'storageObjects', v_count, 'readyForAuthDeletion', v_deletion.state = 'ready_for_auth_deletion');
end;
$$;

create function conuo_private.lock_account_deletion_object(
  p_deletion_id uuid,
  p_bucket_id text,
  p_storage_path text,
  p_lease_token uuid
) returns public.account_deletion_objects language plpgsql set search_path = '' as $$
declare v_object public.account_deletion_objects%rowtype;
begin
  if p_deletion_id is null or p_bucket_id is null or length(p_bucket_id) not between 1 and 100
    or p_storage_path is null or length(p_storage_path) not between 1 and 2048 or p_lease_token is null then
    raise exception using errcode = '22023', message = 'Invalid account deletion object lease';
  end if;
  select * into v_object from public.account_deletion_objects object
    where object.deletion_id = p_deletion_id and object.bucket_id = p_bucket_id
      and object.storage_path = p_storage_path for update;
  if not found or v_object.state <> 'processing' or v_object.lease_token is distinct from p_lease_token
    or v_object.lease_until is null or v_object.lease_until <= clock_timestamp() then
    raise exception using errcode = '40001', message = 'Account deletion object lease unavailable';
  end if;
  return v_object;
end;
$$;

-- Claims are sourced exclusively from account_deletion_objects created by prepare. The
-- worker cannot supply an owner, bucket, or path; all three are derived server-side.
create function public.claim_account_deletion_objects(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_object public.account_deletion_objects%rowtype;
  v_deletion public.account_deletions%rowtype;
  v_candidate record;
  v_objects jsonb := '[]'::jsonb;
begin
  if not conuo_private.valid_id(p_worker_id) or p_limit is null or p_limit not between 1 and 10
    or p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception using errcode = '22023', message = 'Invalid account deletion object claim';
  end if;
  for v_candidate in
    select object.deletion_id, object.bucket_id, object.storage_path
    from public.account_deletion_objects object
    join public.account_deletions deletion on deletion.deletion_id = object.deletion_id
    where ((object.state = 'pending' and object.next_attempt_at <= clock_timestamp())
      or (object.state = 'processing' and object.lease_until <= clock_timestamp()))
      and deletion.state in ('storage_pending', 'storage_processing')
    order by object.next_attempt_at, object.created_at, object.deletion_id, object.bucket_id, object.storage_path
    limit p_limit * 100
  loop
    select object.* into v_object
      from public.account_deletion_objects object
      join public.account_deletions deletion on deletion.deletion_id = object.deletion_id
      where object.deletion_id = v_candidate.deletion_id and object.bucket_id = v_candidate.bucket_id
        and object.storage_path = v_candidate.storage_path
        and ((object.state = 'pending' and object.next_attempt_at <= clock_timestamp())
          or (object.state = 'processing' and object.lease_until <= clock_timestamp()))
        and deletion.state in ('storage_pending', 'storage_processing')
      for update of object skip locked;
    if not found then continue; end if;
    if v_object.attempts >= 5 then
      update public.account_deletion_objects object set
        state = 'failed', worker_id = null, lease_token = null, lease_until = null,
        last_error = case when v_object.state = 'processing' then 'LEASE_EXPIRED' else 'ATTEMPTS_EXHAUSTED' end,
        updated_at = clock_timestamp()
        where object.deletion_id = v_object.deletion_id and object.bucket_id = v_object.bucket_id
          and object.storage_path = v_object.storage_path;
      perform conuo_private.refresh_account_deletion_state(v_object.deletion_id);
      continue;
    end if;
    update public.account_deletion_objects object set
      state = 'processing', attempts = attempts + 1, worker_id = p_worker_id,
      lease_token = gen_random_uuid(),
      lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_error = null, updated_at = clock_timestamp()
      where object.deletion_id = v_object.deletion_id and object.bucket_id = v_object.bucket_id
        and object.storage_path = v_object.storage_path
      returning * into v_object;
    v_deletion := conuo_private.refresh_account_deletion_state(v_object.deletion_id);
    v_objects := v_objects || jsonb_build_array(jsonb_build_object(
      'deletionId', v_object.deletion_id,
      'ownerId', v_deletion.owner_id,
      'bucketId', v_object.bucket_id,
      'storagePath', v_object.storage_path,
      'leaseToken', v_object.lease_token,
      'leaseUntil', v_object.lease_until,
      'attempt', v_object.attempts
    ));
    exit when jsonb_array_length(v_objects) >= p_limit;
  end loop;
  return jsonb_build_object('objects', v_objects);
end;
$$;

create function public.heartbeat_account_deletion_object(
  p_deletion_id uuid,
  p_bucket_id text,
  p_storage_path text,
  p_lease_token uuid,
  p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_object public.account_deletion_objects%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception using errcode = '22023', message = 'Invalid account deletion object lease duration';
  end if;
  v_object := conuo_private.lock_account_deletion_object(
    p_deletion_id, p_bucket_id, p_storage_path, p_lease_token
  );
  update public.account_deletion_objects object set
    lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), updated_at = clock_timestamp()
    where object.deletion_id = v_object.deletion_id and object.bucket_id = v_object.bucket_id
      and object.storage_path = v_object.storage_path returning * into v_object;
  return jsonb_build_object('leaseUntil', v_object.lease_until);
end;
$$;

create function public.complete_account_deletion_object(
  p_deletion_id uuid,
  p_bucket_id text,
  p_storage_path text,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_object public.account_deletion_objects%rowtype; v_deletion public.account_deletions%rowtype;
begin
  v_object := conuo_private.lock_account_deletion_object(
    p_deletion_id, p_bucket_id, p_storage_path, p_lease_token
  );
  update public.account_deletion_objects object set
    state = 'completed', worker_id = null, lease_token = null, lease_until = null,
    last_error = null, completed_at = clock_timestamp(), updated_at = clock_timestamp()
    where object.deletion_id = v_object.deletion_id and object.bucket_id = v_object.bucket_id
      and object.storage_path = v_object.storage_path returning * into v_object;
  v_deletion := conuo_private.refresh_account_deletion_state(v_object.deletion_id);
  return jsonb_build_object('state', v_object.state, 'deletionState', v_deletion.state,
    'completedAt', v_object.completed_at);
end;
$$;

create function public.fail_account_deletion_object(
  p_deletion_id uuid,
  p_bucket_id text,
  p_storage_path text,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_object public.account_deletion_objects%rowtype;
  v_deletion public.account_deletions%rowtype;
  v_retry boolean;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' or p_retryable is null then
    raise exception using errcode = '22023', message = 'Invalid account deletion object failure';
  end if;
  v_object := conuo_private.lock_account_deletion_object(
    p_deletion_id, p_bucket_id, p_storage_path, p_lease_token
  );
  v_retry := p_retryable and v_object.attempts < 5;
  update public.account_deletion_objects object set
    state = case when v_retry then 'pending' else 'failed' end,
    worker_id = null, lease_token = null, lease_until = null,
    next_attempt_at = case when v_retry then clock_timestamp() + make_interval(
      secs => least(900, 15 * (2 ^ (v_object.attempts - 1))::integer)
    ) else next_attempt_at end,
    last_error = p_error_code, updated_at = clock_timestamp()
    where object.deletion_id = v_object.deletion_id and object.bucket_id = v_object.bucket_id
      and object.storage_path = v_object.storage_path returning * into v_object;
  v_deletion := conuo_private.refresh_account_deletion_state(v_object.deletion_id);
  return jsonb_build_object('state', v_object.state, 'deletionState', v_deletion.state,
    'nextAttemptAt', case when v_object.state = 'pending' then v_object.next_attempt_at else null end);
end;
$$;

create function conuo_private.lock_account_auth_deletion(
  p_deletion_id uuid,
  p_lease_token uuid
) returns public.account_deletions language plpgsql set search_path = '' as $$
declare v_deletion public.account_deletions%rowtype;
begin
  if p_deletion_id is null or p_lease_token is null then
    raise exception using errcode = '22023', message = 'Invalid account deletion Auth lease';
  end if;
  select * into v_deletion from public.account_deletions deletion
    where deletion.deletion_id = p_deletion_id for update;
  if not found or v_deletion.state <> 'auth_deletion_processing'
    or v_deletion.auth_lease_token is distinct from p_lease_token
    or v_deletion.auth_lease_until is null or v_deletion.auth_lease_until <= clock_timestamp() then
    raise exception using errcode = '40001', message = 'Account deletion Auth lease unavailable';
  end if;
  return v_deletion;
end;
$$;

-- Auth is claimed only after the Storage queue has drained and a fresh direct view of
-- storage.objects is empty. The restrictive RLS policy blocks new authenticated uploads;
-- this lock also waits for an upload transaction that started before preparation.
create function public.claim_ready_account_auth_deletions(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 60
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_deletion public.account_deletions%rowtype;
  v_candidate record;
  v_deletions jsonb := '[]'::jsonb;
begin
  if not conuo_private.valid_id(p_worker_id) or p_limit is null or p_limit not between 1 and 10
    or p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception using errcode = '22023', message = 'Invalid account deletion Auth claim';
  end if;
  for v_candidate in
    select deletion.deletion_id from public.account_deletions deletion
      where (deletion.state = 'ready_for_auth_deletion' and deletion.auth_next_attempt_at <= clock_timestamp())
        or (deletion.state = 'auth_deletion_processing' and deletion.auth_lease_until <= clock_timestamp())
      order by deletion.auth_next_attempt_at, deletion.requested_at, deletion.deletion_id
      limit p_limit * 100
  loop
    select * into v_deletion from public.account_deletions deletion
      where deletion.deletion_id = v_candidate.deletion_id
        and ((deletion.state = 'ready_for_auth_deletion' and deletion.auth_next_attempt_at <= clock_timestamp())
          or (deletion.state = 'auth_deletion_processing' and deletion.auth_lease_until <= clock_timestamp()))
      for update skip locked;
    if not found then continue; end if;
    if v_deletion.state = 'auth_deletion_processing' then
      if v_deletion.auth_attempts >= 5 then
        update public.account_deletions deletion set state = 'failed', auth_worker_id = null,
          auth_lease_token = null, auth_lease_until = null, last_error = 'AUTH_LEASE_EXPIRED',
          updated_at = clock_timestamp() where deletion.deletion_id = v_deletion.deletion_id;
        continue;
      end if;
      update public.account_deletions deletion set state = 'ready_for_auth_deletion', auth_worker_id = null,
        auth_lease_token = null, auth_lease_until = null, last_error = 'AUTH_LEASE_EXPIRED',
        updated_at = clock_timestamp() where deletion.deletion_id = v_deletion.deletion_id
        returning * into v_deletion;
    end if;
    -- Prevent an in-flight Storage insert from crossing the last no-object observation.
    lock table storage.objects in share row exclusive mode;
    perform conuo_private.capture_account_deletion_storage(v_deletion.deletion_id, v_deletion.owner_id);
    v_deletion := conuo_private.refresh_account_deletion_state(v_deletion.deletion_id);
    if v_deletion.state <> 'ready_for_auth_deletion' then continue; end if;
    if exists (
      select 1 from public.account_deletion_objects object
      where object.deletion_id = v_deletion.deletion_id and object.state <> 'completed'
    ) or exists (
      select 1 from storage.objects object where (storage.foldername(object.name))[1] = v_deletion.owner_id::text
    ) then
      -- Defensive duplicate check: capture normally makes this branch impossible.
      continue;
    end if;
    if v_deletion.auth_attempts >= 5 then
      update public.account_deletions deletion set state = 'failed', last_error = 'AUTH_ATTEMPTS_EXHAUSTED',
        updated_at = clock_timestamp() where deletion.deletion_id = v_deletion.deletion_id;
      continue;
    end if;
    update public.account_deletions deletion set state = 'auth_deletion_processing',
      auth_attempts = auth_attempts + 1, auth_worker_id = p_worker_id, auth_lease_token = gen_random_uuid(),
      auth_lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), last_error = null,
      updated_at = clock_timestamp() where deletion.deletion_id = v_deletion.deletion_id returning * into v_deletion;
    v_deletions := v_deletions || jsonb_build_array(jsonb_build_object(
      'deletionId', v_deletion.deletion_id,
      'ownerId', v_deletion.owner_id,
      'leaseToken', v_deletion.auth_lease_token,
      'leaseUntil', v_deletion.auth_lease_until,
      'attempt', v_deletion.auth_attempts
    ));
    exit when jsonb_array_length(v_deletions) >= p_limit;
  end loop;
  return jsonb_build_object('deletions', v_deletions);
end;
$$;

create function public.heartbeat_account_auth_deletion(
  p_deletion_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 60
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_deletion public.account_deletions%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception using errcode = '22023', message = 'Invalid account deletion Auth lease duration';
  end if;
  v_deletion := conuo_private.lock_account_auth_deletion(p_deletion_id, p_lease_token);
  update public.account_deletions deletion set
    auth_lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), updated_at = clock_timestamp()
    where deletion.deletion_id = v_deletion.deletion_id returning * into v_deletion;
  return jsonb_build_object('leaseUntil', v_deletion.auth_lease_until);
end;
$$;

create function public.complete_account_auth_deletion(
  p_deletion_id uuid,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_deletion public.account_deletions%rowtype;
begin
  v_deletion := conuo_private.lock_account_auth_deletion(p_deletion_id, p_lease_token);
  if exists (select 1 from auth.users user_row where user_row.id = v_deletion.owner_id) then
    raise exception using errcode = '40001', message = 'Account Auth deletion not confirmed';
  end if;
  -- The Auth call may have taken time. Recheck under a Storage write-conflicting lock;
  -- any late path is requeued and must be removed before the final completed state.
  lock table storage.objects in share row exclusive mode;
  perform conuo_private.capture_account_deletion_storage(v_deletion.deletion_id, v_deletion.owner_id);
  if exists (
    select 1 from public.account_deletion_objects object
    where object.deletion_id = v_deletion.deletion_id and object.state <> 'completed'
  ) or exists (
    select 1 from storage.objects object where (storage.foldername(object.name))[1] = v_deletion.owner_id::text
  ) then
    update public.account_deletions deletion set state = 'storage_pending', auth_worker_id = null,
      auth_lease_token = null, auth_lease_until = null, last_error = 'STORAGE_REOPENED',
      updated_at = clock_timestamp() where deletion.deletion_id = v_deletion.deletion_id;
    v_deletion := conuo_private.refresh_account_deletion_state(v_deletion.deletion_id);
    return jsonb_build_object('state', v_deletion.state, 'storageReopened', true);
  end if;
  update public.account_deletions deletion set state = 'completed', auth_worker_id = null,
    auth_lease_token = null, auth_lease_until = null, last_error = null,
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
    where deletion.deletion_id = v_deletion.deletion_id returning * into v_deletion;
  return jsonb_build_object('state', v_deletion.state, 'completedAt', v_deletion.completed_at,
    'storageReopened', false);
end;
$$;

create function public.fail_account_auth_deletion(
  p_deletion_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_deletion public.account_deletions%rowtype; v_retry boolean;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' or p_retryable is null then
    raise exception using errcode = '22023', message = 'Invalid account deletion Auth failure';
  end if;
  v_deletion := conuo_private.lock_account_auth_deletion(p_deletion_id, p_lease_token);
  v_retry := p_retryable and v_deletion.auth_attempts < 5;
  update public.account_deletions deletion set
    state = case when v_retry then 'ready_for_auth_deletion' else 'failed' end,
    auth_worker_id = null, auth_lease_token = null, auth_lease_until = null,
    auth_next_attempt_at = case when v_retry then clock_timestamp() + make_interval(
      secs => least(900, 15 * (2 ^ (v_deletion.auth_attempts - 1))::integer)
    ) else auth_next_attempt_at end,
    last_error = p_error_code, updated_at = clock_timestamp()
    where deletion.deletion_id = v_deletion.deletion_id returning * into v_deletion;
  return jsonb_build_object('state', v_deletion.state,
    'nextAttemptAt', case when v_deletion.state = 'ready_for_auth_deletion'
      then v_deletion.auth_next_attempt_at else null end);
end;
$$;

-- Explicit service retry resets only terminal failures. It does not remove the deny
-- record or reopen the account; automatic retries remain capped at five attempts.
create function public.retry_account_deletion(p_deletion_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_deletion public.account_deletions%rowtype; v_reset integer;
begin
  if p_deletion_id is null then raise exception using errcode = '22023', message = 'Invalid account deletion retry'; end if;
  select * into v_deletion from public.account_deletions deletion
    where deletion.deletion_id = p_deletion_id for update;
  if not found or v_deletion.state <> 'failed' then
    raise exception using errcode = '40001', message = 'Account deletion cannot retry';
  end if;
  if exists (select 1 from public.account_deletion_objects object
    where object.deletion_id = v_deletion.deletion_id and object.state = 'processing'
      and object.lease_until > clock_timestamp()) then
    raise exception using errcode = '40001', message = 'Account deletion has active Storage lease';
  end if;
  update public.account_deletion_objects object set state = 'pending', attempts = 0,
    worker_id = null, lease_token = null, lease_until = null, next_attempt_at = clock_timestamp(),
    last_error = null, updated_at = clock_timestamp()
    where object.deletion_id = v_deletion.deletion_id and object.state = 'failed';
  get diagnostics v_reset = row_count;
  update public.account_deletions deletion set
    state = case when v_reset > 0 then 'storage_pending' else 'ready_for_auth_deletion' end,
    auth_attempts = 0, auth_worker_id = null, auth_lease_token = null, auth_lease_until = null,
    auth_next_attempt_at = clock_timestamp(), last_error = null, updated_at = clock_timestamp()
    where deletion.deletion_id = v_deletion.deletion_id;
  v_deletion := conuo_private.refresh_account_deletion_state(v_deletion.deletion_id);
  return jsonb_build_object('state', v_deletion.state, 'retriedStorageObjects', v_reset);
end;
$$;

revoke all on function conuo_private.account_deletion_blocked(uuid),
  conuo_private.assert_account_access(uuid),
  conuo_private.account_deletion_preview(uuid),
  conuo_private.capture_account_deletion_storage(uuid,uuid),
  conuo_private.refresh_account_deletion_state(uuid),
  conuo_private.lock_account_deletion_object(uuid,text,text,uuid),
  conuo_private.lock_account_auth_deletion(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.account_deletion_access_allowed(),
  public.account_deletion_access_status(),
  public.preview_account_deletion(),
  public.prepare_account_deletion(uuid),
  public.claim_account_deletion_objects(text,integer,integer),
  public.heartbeat_account_deletion_object(uuid,text,text,uuid,integer),
  public.complete_account_deletion_object(uuid,text,text,uuid),
  public.fail_account_deletion_object(uuid,text,text,uuid,text,boolean),
  public.claim_ready_account_auth_deletions(text,integer,integer),
  public.heartbeat_account_auth_deletion(uuid,uuid,integer),
  public.complete_account_auth_deletion(uuid,uuid),
  public.fail_account_auth_deletion(uuid,uuid,text,boolean),
  public.retry_account_deletion(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.account_deletion_access_allowed(),
  public.account_deletion_access_status(),
  public.preview_account_deletion()
  to authenticated;
grant execute on function public.prepare_account_deletion(uuid),
  public.claim_account_deletion_objects(text,integer,integer),
  public.heartbeat_account_deletion_object(uuid,text,text,uuid,integer),
  public.complete_account_deletion_object(uuid,text,text,uuid),
  public.fail_account_deletion_object(uuid,text,text,uuid,text,boolean),
  public.claim_ready_account_auth_deletions(text,integer,integer),
  public.heartbeat_account_auth_deletion(uuid,uuid,integer),
  public.complete_account_auth_deletion(uuid,uuid),
  public.fail_account_auth_deletion(uuid,uuid,text,boolean),
  public.retry_account_deletion(uuid)
  to service_role;

commit;
