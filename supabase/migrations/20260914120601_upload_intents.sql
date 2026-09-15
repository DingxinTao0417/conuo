-- Bind private Storage originals to a durable, quota-aware upload intent.
--
-- Browser uploads remain direct to Supabase Storage.  The transaction boundary is:
-- reserve intent -> immutable Storage insert -> complete intent -> workspace CAS.
-- A workspace BEFORE trigger commits the matching intent in the same transaction as
-- every snapshot writer, so an interrupted browser never turns an uploaded original
-- into a source reference without a recoverable server-side record.
begin;

create table conuo_private.original_upload_intents (
  intent_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_id text not null check (source_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  version_id text not null check (version_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  kind text not null check (kind in ('pdf','docx','markdown','text','web')),
  storage_path text not null unique,
  expected_bytes bigint not null check (expected_bytes between 0 and 31457280),
  -- Legacy committed paths are backfilled without a trustworthy SHA-256. Every
  -- newly reserved path requires one, and the workspace trigger matches it exactly.
  expected_sha256 text check (expected_sha256 is null or expected_sha256 ~ '^[a-f0-9]{64}$'),
  content_type text not null check (length(content_type) between 1 and 200),
  state text not null check (state in (
    'reserved','uploaded','committed','cleanup_pending','processing','released','failed'
  )),
  reservation_token uuid,
  reservation_until timestamptz,
  uploaded_at timestamptz,
  committed_revision bigint check (committed_revision is null or committed_revision > 0),
  worker_id text check (worker_id is null or worker_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  last_error text check (last_error is null or last_error ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, source_id, version_id),
  check (
    (state in ('reserved','uploaded') and reservation_token is not null and reservation_until is not null)
    or (state not in ('reserved','uploaded') and reservation_token is null and reservation_until is null)
  ),
  check (
    (state = 'processing' and worker_id is not null and lease_token is not null and lease_until is not null)
    or (state <> 'processing' and worker_id is null and lease_token is null and lease_until is null)
  ),
  check (
    (state = 'committed' and committed_revision is not null)
    or (state <> 'committed')
  )
);

alter table conuo_private.original_upload_intents enable row level security;
revoke all on table conuo_private.original_upload_intents from public, anon, authenticated, service_role;
create index original_upload_intents_cleanup_dispatch
  on conuo_private.original_upload_intents(next_attempt_at, lease_until, created_at, intent_id)
  where state in ('reserved','uploaded','cleanup_pending','processing');

-- Keep these operational limits private and centralized. They deliberately mirror the
-- current conservative browser policy; they are not a product-facing storage promise.
create function conuo_private.original_upload_limits()
returns table(max_file_bytes bigint, max_account_bytes bigint)
language sql immutable set search_path = '' as $$
  select 31457280::bigint, 536870912::bigint;
$$;

create function conuo_private.canonical_original_storage_path(
  p_owner uuid,
  p_source_id text,
  p_version_id text,
  p_kind text
) returns text language plpgsql immutable set search_path = '' as $$
declare v_extension text;
begin
  if p_owner is null
    or not conuo_private.valid_id(p_source_id)
    or not conuo_private.valid_id(p_version_id) then
    raise exception using errcode = '22023', message = 'Invalid original upload identity';
  end if;
  v_extension := case p_kind
    when 'pdf' then 'pdf'
    when 'docx' then 'docx'
    when 'markdown' then 'md'
    when 'text' then 'txt'
    when 'web' then 'html'
    else null
  end;
  if v_extension is null then
    raise exception using errcode = '22023', message = 'Invalid original upload kind';
  end if;
  return p_owner::text || '/' || p_version_id || '/' || p_source_id || '.' || v_extension;
end;
$$;

-- `storage.objects.metadata->>'size'` is written by Supabase Storage. Never coerce an
-- unknown value to zero: malformed platform metadata must not create free capacity.
create function conuo_private.storage_object_bytes(p_metadata jsonb)
returns bigint language plpgsql immutable set search_path = '' as $$
declare v_size text;
begin
  v_size := p_metadata->>'size';
  if v_size is null or v_size !~ '^[0-9]{1,18}$' then return null; end if;
  return v_size::bigint;
exception when numeric_value_out_of_range then
  return null;
end;
$$;

create function conuo_private.active_original_upload_usage(p_owner uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  with limits as (
    select max_file_bytes from conuo_private.original_upload_limits()
  ), physical as (
    select object.name as storage_path,
      coalesce(conuo_private.storage_object_bytes(object.metadata), limits.max_file_bytes) as bytes
    from storage.objects object cross join limits
    where object.bucket_id = 'originals'
      and (storage.foldername(object.name))[1] = p_owner::text
  ), pending as (
    select intent.storage_path, intent.expected_bytes as bytes
    from conuo_private.original_upload_intents intent
    where intent.owner_id = p_owner
      and intent.state in ('reserved','uploaded','cleanup_pending','processing')
      and not exists (
        select 1 from physical object where object.storage_path = intent.storage_path
      )
  )
  select coalesce(sum(bytes), 0)::bigint from (
    select storage_path, bytes from physical
    union all
    select storage_path, bytes from pending
  ) usage;
$$;

-- Storage evaluates the policy as the authenticated browser role, so this narrow
-- security-definer wrapper is the only direct-table access it needs. The browser never
-- supplies another owner or a reusable path: both must match a live exact reservation.
create function conuo_private.original_upload_storage_insert_allowed(
  p_bucket_id text,
  p_storage_path text,
  p_metadata jsonb
) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_bytes bigint := conuo_private.storage_object_bytes(p_metadata);
begin
  if v_owner is null or p_bucket_id <> 'originals' or v_bytes is null then return false; end if;
  if not public.account_deletion_access_allowed() then return false; end if;
  return exists (
    select 1
      from conuo_private.original_upload_intents intent
      where intent.owner_id = v_owner
        and intent.storage_path = p_storage_path
        and intent.state in ('reserved','uploaded')
        and intent.reservation_until > clock_timestamp()
        and intent.expected_bytes = v_bytes
  );
end;
$$;

drop policy if exists "Upload own originals" on storage.objects;
create policy "Upload reserved originals" on storage.objects for insert to authenticated
  with check (conuo_private.original_upload_storage_insert_allowed(bucket_id, name, metadata));

create function public.reserve_original_upload(
  p_source_id text,
  p_version_id text,
  p_kind text,
  p_expected_bytes bigint,
  p_expected_sha256 text,
  p_content_type text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_intent conuo_private.original_upload_intents%rowtype;
  v_path text;
  v_max_file bigint;
  v_max_account bigint;
  v_used bigint;
  v_until timestamptz := clock_timestamp() + interval '15 minutes';
  v_has_intent boolean := false;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  select max_file_bytes, max_account_bytes into v_max_file, v_max_account
    from conuo_private.original_upload_limits();
  if not conuo_private.valid_id(p_source_id)
    or not conuo_private.valid_id(p_version_id)
    or p_kind not in ('pdf','docx','markdown','text','web')
    or p_expected_bytes is null or p_expected_bytes not between 0 and v_max_file
    or p_expected_sha256 is null or p_expected_sha256 !~ '^[a-f0-9]{64}$'
    or p_content_type is null or length(btrim(p_content_type)) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Invalid original upload reservation';
  end if;

  perform conuo_private.owner_lock(v_owner);
  v_path := conuo_private.canonical_original_storage_path(v_owner, p_source_id, p_version_id, p_kind);
  select * into v_intent
    from conuo_private.original_upload_intents intent
    where intent.owner_id = v_owner and intent.source_id = p_source_id and intent.version_id = p_version_id
    for update;
  v_has_intent := found;

  if v_has_intent then
    if v_intent.kind <> p_kind
      or v_intent.expected_bytes <> p_expected_bytes
      or v_intent.expected_sha256 is distinct from p_expected_sha256
      or v_intent.storage_path <> v_path then
      raise exception using errcode = '22023', message = 'Original upload identity already differs';
    end if;
    if v_intent.state = 'committed' then
      return jsonb_build_object(
        'status', 'committed', 'intentId', v_intent.intent_id,
        'storagePath', v_intent.storage_path, 'reservationToken', null,
        'reservationUntil', null
      );
    end if;
    if v_intent.state in ('cleanup_pending','processing','failed') then
      raise exception using errcode = '55P03', message = 'Original upload cleanup is in progress';
    end if;
    if v_intent.state in ('reserved','uploaded') then
      update conuo_private.original_upload_intents intent
        set reservation_until = v_until, updated_at = clock_timestamp()
        where intent.intent_id = v_intent.intent_id
        returning * into v_intent;
      return jsonb_build_object(
        'status', v_intent.state, 'intentId', v_intent.intent_id,
        'storagePath', v_intent.storage_path, 'reservationToken', v_intent.reservation_token,
        'reservationUntil', v_intent.reservation_until
      );
    end if;
    -- A worker has confirmed that a previously uncommitted object is gone, so this
    -- immutable source/version identity can reserve the same canonical path again.
    if v_intent.state <> 'released' then
      raise exception using errcode = '40001', message = 'Original upload unavailable';
    end if;
  end if;

  v_used := conuo_private.active_original_upload_usage(v_owner);
  if v_used > v_max_account - p_expected_bytes then
    raise exception using errcode = '22023', message = 'Original storage capacity exceeded';
  end if;

  if v_has_intent then
    update conuo_private.original_upload_intents intent
      set expected_bytes = p_expected_bytes,
          expected_sha256 = p_expected_sha256,
          content_type = btrim(p_content_type),
          state = 'reserved', reservation_token = gen_random_uuid(), reservation_until = v_until,
          uploaded_at = null, committed_revision = null, attempts = 0, next_attempt_at = clock_timestamp(),
          last_error = null, released_at = null, updated_at = clock_timestamp()
      where intent.intent_id = v_intent.intent_id
      returning * into v_intent;
  else
    insert into conuo_private.original_upload_intents(
      owner_id, source_id, version_id, kind, storage_path, expected_bytes, expected_sha256,
      content_type, state, reservation_token, reservation_until
    ) values (
      v_owner, p_source_id, p_version_id, p_kind, v_path, p_expected_bytes, p_expected_sha256,
      btrim(p_content_type), 'reserved', gen_random_uuid(), v_until
    ) returning * into v_intent;
  end if;
  return jsonb_build_object(
    'status', 'reserved', 'intentId', v_intent.intent_id,
    'storagePath', v_intent.storage_path, 'reservationToken', v_intent.reservation_token,
    'reservationUntil', v_intent.reservation_until
  );
end;
$$;

create function public.complete_original_upload(
  p_intent_id uuid,
  p_reservation_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_intent conuo_private.original_upload_intents%rowtype;
  v_bytes bigint;
  v_until timestamptz := clock_timestamp() + interval '15 minutes';
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_intent_id is null or p_reservation_token is null then
    raise exception using errcode = '22023', message = 'Invalid original upload completion';
  end if;
  perform conuo_private.owner_lock(v_owner);
  select * into v_intent
    from conuo_private.original_upload_intents intent
    where intent.intent_id = p_intent_id and intent.owner_id = v_owner
    for update;
  if not found then
    raise exception using errcode = '40001', message = 'Original upload reservation unavailable';
  end if;
  if v_intent.state = 'committed' then
    return jsonb_build_object(
      'status', 'committed', 'intentId', v_intent.intent_id,
      'storagePath', v_intent.storage_path, 'reservationUntil', null
    );
  end if;
  if v_intent.state not in ('reserved','uploaded')
    or v_intent.reservation_token is distinct from p_reservation_token
    or v_intent.reservation_until <= clock_timestamp() then
    raise exception using errcode = '40001', message = 'Original upload reservation unavailable';
  end if;
  select conuo_private.storage_object_bytes(object.metadata) into v_bytes
    from storage.objects object
    where object.bucket_id = 'originals' and object.name = v_intent.storage_path;
  if v_bytes is distinct from v_intent.expected_bytes then
    raise exception using errcode = '22023', message = 'Original upload bytes do not match reservation';
  end if;
  update conuo_private.original_upload_intents intent
    set state = 'uploaded', uploaded_at = coalesce(intent.uploaded_at, clock_timestamp()),
        reservation_until = v_until, updated_at = clock_timestamp()
    where intent.intent_id = v_intent.intent_id
    returning * into v_intent;
  return jsonb_build_object(
    'status', 'uploaded', 'intentId', v_intent.intent_id,
    'storagePath', v_intent.storage_path, 'reservationUntil', v_intent.reservation_until
  );
end;
$$;

-- This runs before every workspace snapshot insert/update. It sees the incoming
-- source/version identities before the later normalized source projection and makes
-- the source reference plus intent state one atomic transaction.
create function conuo_private.commit_original_upload_intents_from_workspace(
  p_owner uuid,
  p_data jsonb,
  p_revision bigint,
  p_previous_data jsonb default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_source jsonb;
  v_version jsonb;
  v_old_source jsonb;
  v_old_version jsonb;
  v_intent conuo_private.original_upload_intents%rowtype;
  v_source_id text;
  v_version_id text;
  v_path text;
  v_size bigint;
  v_storage_bytes bigint;
begin
  if p_owner is null or p_revision is null or p_revision < 1
    or jsonb_typeof(p_data->'sources') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid original upload workspace';
  end if;
  for v_source in select value from jsonb_array_elements(p_data->'sources') loop
    v_source_id := v_source->>'id';
    for v_version in
      select value from jsonb_array_elements(
        jsonb_build_array(v_source) || coalesce(v_source->'versions', '[]'::jsonb)
      )
    loop
      if not (v_version ? 'storagePath') then continue; end if;
      v_version_id := v_version->>'versionId';
      v_path := v_version->>'storagePath';
      if not conuo_private.valid_id(v_source_id)
        or not conuo_private.valid_id(v_version_id)
        or v_version->>'kind' not in ('pdf','docx','markdown','text','web')
        or coalesce(v_version->>'size','') !~ '^[0-9]+$'
        or (v_version->>'size')::numeric > 31457280
        or coalesce(v_version->>'hash','') !~ '^[a-f0-9]{64}$'
        or v_path <> conuo_private.canonical_original_storage_path(
          p_owner, v_source_id, v_version_id, v_version->>'kind'
        ) then
        raise exception using errcode = '22023', message = 'Invalid original upload workspace identity';
      end if;
      v_size := (v_version->>'size')::bigint;
      if p_previous_data is not null and jsonb_typeof(p_previous_data->'sources') = 'array' then
        select old_source.value, old_version.value into v_old_source, v_old_version
          from jsonb_array_elements(p_previous_data->'sources') old_source(value)
          cross join lateral jsonb_array_elements(
            jsonb_build_array(old_source.value) || coalesce(old_source.value->'versions', '[]'::jsonb)
          ) old_version(value)
          where old_source.value->>'id' = v_source_id
            and old_version.value->>'versionId' = v_version_id
            and old_version.value->>'storagePath' = v_path
          limit 1;
        if found then continue; end if;
      end if;
      select * into v_intent
        from conuo_private.original_upload_intents intent
        where intent.owner_id = p_owner
          and intent.source_id = v_source_id
          and intent.version_id = v_version_id
          and intent.kind = v_version->>'kind'
          and intent.storage_path = v_path
          and intent.expected_bytes = v_size
          and intent.expected_sha256 = v_version->>'hash'
          and intent.state in ('uploaded','committed')
        for update;
      if not found then
        raise exception using errcode = '22023', message = 'Original upload has not completed';
      end if;
      select conuo_private.storage_object_bytes(object.metadata) into v_storage_bytes
        from storage.objects object
        where object.bucket_id = 'originals' and object.name = v_path;
      if v_storage_bytes is distinct from v_size then
        raise exception using errcode = '22023', message = 'Original upload object is unavailable';
      end if;
      if v_intent.state = 'uploaded' then
        update conuo_private.original_upload_intents intent
          set state = 'committed', reservation_token = null, reservation_until = null,
              committed_revision = p_revision, updated_at = clock_timestamp()
          where intent.intent_id = v_intent.intent_id;
      end if;
    end loop;
  end loop;
end;
$$;

create function conuo_private.commit_original_upload_intents_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.data->'sources' is not distinct from new.data->'sources' then
    return new;
  end if;
  perform conuo_private.commit_original_upload_intents_from_workspace(
    new.owner_id, new.data, new.revision,
    case when tg_op = 'UPDATE' then old.data else null end
  );
  return new;
end;
$$;

drop trigger if exists commit_workspace_original_upload_intents on public.workspaces;
create trigger commit_workspace_original_upload_intents
before insert or update of data on public.workspaces
for each row execute function conuo_private.commit_original_upload_intents_from_workspace_trigger();

-- Storage cleanup is an outbox: a lost browser upload response is never assumed to
-- have failed. Expired reservations move through a service-only lease and release
-- capacity only after the worker deletes the physical object (or observes 404).
create function conuo_private.lock_original_upload_cleanup(
  p_intent_id uuid,
  p_lease_token uuid
) returns conuo_private.original_upload_intents
language plpgsql set search_path = '' as $$
declare v_intent conuo_private.original_upload_intents%rowtype;
begin
  if p_intent_id is null or p_lease_token is null then
    raise exception using errcode = '22023', message = 'Invalid original upload cleanup lease';
  end if;
  select * into v_intent from conuo_private.original_upload_intents intent
    where intent.intent_id = p_intent_id for update;
  if not found or v_intent.state <> 'processing'
    or v_intent.lease_token is distinct from p_lease_token
    or v_intent.lease_until is null or v_intent.lease_until <= clock_timestamp() then
    raise exception using errcode = '40001', message = 'Original upload cleanup lease unavailable';
  end if;
  return v_intent;
end;
$$;

create function public.claim_expired_original_upload_intents(
  p_worker_id text,
  p_limit integer default 3,
  p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_candidate uuid;
  v_intent conuo_private.original_upload_intents%rowtype;
  v_intents jsonb := '[]'::jsonb;
begin
  if p_worker_id is null or p_worker_id !~ '^[a-zA-Z0-9_-]{1,80}$'
    or p_limit is null or p_limit not between 1 and 5
    or p_lease_seconds is null or p_lease_seconds not between 30 and 180 then
    raise exception using errcode = '22023', message = 'Invalid original upload cleanup claim';
  end if;
  for v_candidate in
    select intent.intent_id from conuo_private.original_upload_intents intent
      where (
        (intent.state in ('reserved','uploaded') and intent.reservation_until <= clock_timestamp())
        or (intent.state = 'cleanup_pending' and intent.next_attempt_at <= clock_timestamp())
        or (intent.state = 'processing' and intent.lease_until <= clock_timestamp())
      )
      order by intent.next_attempt_at, intent.created_at, intent.intent_id
      limit p_limit * 100
  loop
    select * into v_intent from conuo_private.original_upload_intents intent
      where intent.intent_id = v_candidate
        and (
          (intent.state in ('reserved','uploaded') and intent.reservation_until <= clock_timestamp())
          or (intent.state = 'cleanup_pending' and intent.next_attempt_at <= clock_timestamp())
          or (intent.state = 'processing' and intent.lease_until <= clock_timestamp())
        )
      for update skip locked;
    if not found then continue; end if;
    if v_intent.attempts >= 5 then
      update conuo_private.original_upload_intents intent
        set state = 'failed', reservation_token = null, reservation_until = null,
            worker_id = null, lease_token = null, lease_until = null,
            last_error = case when v_intent.state = 'processing' then 'LEASE_EXPIRED' else 'ATTEMPTS_EXHAUSTED' end,
            updated_at = clock_timestamp()
        where intent.intent_id = v_intent.intent_id;
      continue;
    end if;
    update conuo_private.original_upload_intents intent
      set state = 'processing', reservation_token = null, reservation_until = null,
          attempts = intent.attempts + 1, worker_id = p_worker_id, lease_token = gen_random_uuid(),
          lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
          last_error = null, updated_at = clock_timestamp()
      where intent.intent_id = v_intent.intent_id
      returning * into v_intent;
    v_intents := v_intents || jsonb_build_array(jsonb_build_object(
      'intentId', v_intent.intent_id,
      'ownerId', v_intent.owner_id,
      'storagePath', v_intent.storage_path,
      'leaseToken', v_intent.lease_token,
      'leaseUntil', v_intent.lease_until,
      'attempt', v_intent.attempts
    ));
    exit when jsonb_array_length(v_intents) >= p_limit;
  end loop;
  return jsonb_build_object('intents', v_intents);
end;
$$;

create function public.heartbeat_original_upload_cleanup(
  p_intent_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent conuo_private.original_upload_intents%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 180 then
    raise exception using errcode = '22023', message = 'Invalid original upload cleanup lease duration';
  end if;
  v_intent := conuo_private.lock_original_upload_cleanup(p_intent_id, p_lease_token);
  update conuo_private.original_upload_intents intent
    set lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        updated_at = clock_timestamp()
    where intent.intent_id = v_intent.intent_id
    returning * into v_intent;
  return jsonb_build_object('leaseUntil', v_intent.lease_until);
end;
$$;

create function public.complete_original_upload_cleanup(
  p_intent_id uuid,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent conuo_private.original_upload_intents%rowtype;
begin
  v_intent := conuo_private.lock_original_upload_cleanup(p_intent_id, p_lease_token);
  update conuo_private.original_upload_intents intent
    set state = 'released', worker_id = null, lease_token = null, lease_until = null,
        last_error = null, released_at = clock_timestamp(), updated_at = clock_timestamp()
    where intent.intent_id = v_intent.intent_id
    returning * into v_intent;
  return jsonb_build_object('state', v_intent.state, 'releasedAt', v_intent.released_at);
end;
$$;

create function public.fail_original_upload_cleanup(
  p_intent_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent conuo_private.original_upload_intents%rowtype;
  v_retry boolean;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' or p_retryable is null then
    raise exception using errcode = '22023', message = 'Invalid original upload cleanup failure';
  end if;
  v_intent := conuo_private.lock_original_upload_cleanup(p_intent_id, p_lease_token);
  v_retry := p_retryable and v_intent.attempts < 5;
  update conuo_private.original_upload_intents intent
    set state = case when v_retry then 'cleanup_pending' else 'failed' end,
        worker_id = null, lease_token = null, lease_until = null,
        next_attempt_at = case when v_retry then clock_timestamp() + make_interval(
          secs => least(900, 15 * (2 ^ (v_intent.attempts - 1))::integer)
        ) else intent.next_attempt_at end,
        last_error = p_error_code, updated_at = clock_timestamp()
    where intent.intent_id = v_intent.intent_id
    returning * into v_intent;
  return jsonb_build_object(
    'state', v_intent.state,
    'nextAttemptAt', case when v_intent.state = 'cleanup_pending' then v_intent.next_attempt_at else null end
  );
end;
$$;

-- Existing canonical source paths predate the intent protocol. Backfill them as
-- committed records so an ordinary metadata save never rejects a valid legacy snapshot.
insert into conuo_private.original_upload_intents(
  owner_id, source_id, version_id, kind, storage_path, expected_bytes, expected_sha256,
  content_type, state, committed_revision, uploaded_at
)
select
  version.owner_id,
  version.source_id,
  version.version_id,
  version.kind,
  version.storage_path,
  case when coalesce(version.manifest->>'size','') ~ '^[0-9]+$'
    then least((version.manifest->>'size')::numeric, 31457280)::bigint else 0 end,
  case when coalesce(version.manifest->>'hash','') ~ '^[a-f0-9]{64}$'
    then version.manifest->>'hash' else null end,
  coalesce(nullif(version.manifest->>'mime',''), 'application/octet-stream'),
  'committed',
  workspace.revision,
  clock_timestamp()
from public.source_versions version
join public.workspaces workspace on workspace.owner_id = version.owner_id
where version.storage_path is not null
on conflict (owner_id, source_id, version_id) do nothing;

revoke all on function conuo_private.original_upload_limits(),
  conuo_private.canonical_original_storage_path(uuid,text,text,text),
  conuo_private.storage_object_bytes(jsonb),
  conuo_private.active_original_upload_usage(uuid),
  conuo_private.commit_original_upload_intents_from_workspace(uuid,jsonb,bigint,jsonb),
  conuo_private.commit_original_upload_intents_from_workspace_trigger(),
  conuo_private.lock_original_upload_cleanup(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function conuo_private.original_upload_storage_insert_allowed(text,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function conuo_private.original_upload_storage_insert_allowed(text,text,jsonb)
  to authenticated;

revoke all on function public.reserve_original_upload(text,text,text,bigint,text,text),
  public.complete_original_upload(uuid,uuid),
  public.claim_expired_original_upload_intents(text,integer,integer),
  public.heartbeat_original_upload_cleanup(uuid,uuid,integer),
  public.complete_original_upload_cleanup(uuid,uuid),
  public.fail_original_upload_cleanup(uuid,uuid,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_original_upload(text,text,text,bigint,text,text),
  public.complete_original_upload(uuid,uuid)
  to authenticated;
grant execute on function public.claim_expired_original_upload_intents(text,integer,integer),
  public.heartbeat_original_upload_cleanup(uuid,uuid,integer),
  public.complete_original_upload_cleanup(uuid,uuid),
  public.fail_original_upload_cleanup(uuid,uuid,text,boolean)
  to service_role;

commit;
