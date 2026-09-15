-- Durable, service-only Storage cleanup queue for irreversible source purges.
-- The worker receives canonical paths and reports the result of its Storage operation;
-- this migration deliberately performs no Storage call itself.
begin;

alter table public.source_purge_objects
  add column worker_id text,
  add column lease_token uuid,
  add column lease_until timestamptz,
  add column next_attempt_at timestamptz,
  add column updated_at timestamptz;

-- Migration 004 shipped the outbox before a worker existed.  A legacy processing
-- row cannot have a trustworthy lease, so make it safely claimable again.
update public.source_purge_objects
  set state = case when state = 'processing' then 'pending' else state end,
      worker_id = null,
      lease_token = null,
      lease_until = null,
      next_attempt_at = coalesce(next_attempt_at, created_at, clock_timestamp()),
      updated_at = coalesce(updated_at, created_at, clock_timestamp()),
      last_error = case when state = 'processing' and last_error is null then 'LEASE_MIGRATED' else last_error end;

alter table public.source_purge_objects
  alter column next_attempt_at set default now(),
  alter column next_attempt_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null,
  add constraint source_purge_objects_worker_id_check
    check (worker_id is null or conuo_private.valid_id(worker_id)),
  add constraint source_purge_objects_lease_state_check
    check (
      (state = 'pending' and worker_id is null and lease_token is null and lease_until is null and completed_at is null)
      or (state = 'processing' and worker_id is not null and lease_token is not null and lease_until is not null and completed_at is null)
      or (state = 'completed' and worker_id is null and lease_token is null and lease_until is null and completed_at is not null)
      or (state = 'failed' and worker_id is null and lease_token is null and lease_until is null and completed_at is null)
    );

drop index if exists public.source_purge_objects_dispatch;
create index source_purge_objects_dispatch on public.source_purge_objects(next_attempt_at, lease_until, created_at, purge_id)
  where state in ('pending', 'processing');

-- Aggregate state is derived from the objects so a partially completed purge never
-- claims success. A terminal object failure keeps the parent visible as failed even
-- while independent objects are still being drained.
create function conuo_private.refresh_source_purge_state(p_purge_id uuid)
returns public.source_purges language plpgsql set search_path = '' as $$
declare
  v_purge public.source_purges%rowtype;
  v_total integer;
  v_completed integer;
  v_processing integer;
  v_failed integer;
  v_state text;
  v_error text;
begin
  select * into v_purge
    from public.source_purges
    where purge_id = p_purge_id
    for update;
  if not found then
    raise exception using errcode = '40001', message = 'Source purge unavailable';
  end if;

  select count(*)::integer,
    count(*) filter (where object.state = 'completed')::integer,
    count(*) filter (where object.state = 'processing')::integer,
    count(*) filter (where object.state = 'failed')::integer
    into v_total, v_completed, v_processing, v_failed
    from public.source_purge_objects object
    where object.purge_id = p_purge_id;

  v_state := case
    when v_total = v_completed then 'completed'
    when v_failed > 0 then 'failed'
    when v_processing > 0 then 'processing'
    else 'pending'
  end;

  if v_state = 'failed' then
    select object.last_error into v_error
      from public.source_purge_objects object
      where object.purge_id = p_purge_id and object.state = 'failed'
      order by object.updated_at desc, object.storage_path
      limit 1;
  end if;

  update public.source_purges
    set state = v_state,
        completed_at = case
          when v_state = 'completed' then coalesce(completed_at, clock_timestamp())
          else null
        end,
        last_error = case when v_state = 'failed' then v_error else null end
    where purge_id = p_purge_id
    returning * into v_purge;
  return v_purge;
end;
$$;

-- A completion, failure, or heartbeat may proceed only while its current lease is
-- valid. Object identity is the immutable purge ID plus canonical Storage path.
create function conuo_private.lock_source_purge_object(
  p_purge_id uuid,
  p_storage_path text,
  p_lease_token uuid
) returns public.source_purge_objects language plpgsql set search_path = '' as $$
declare v_object public.source_purge_objects%rowtype;
begin
  if p_purge_id is null or p_storage_path is null or length(p_storage_path) not between 1 and 2048
    or p_lease_token is null then
    raise exception using errcode = '22023', message = 'Invalid source purge lease';
  end if;
  select * into v_object
    from public.source_purge_objects
    where purge_id = p_purge_id and storage_path = p_storage_path
    for update;
  if not found or v_object.state <> 'processing'
    or v_object.lease_token is distinct from p_lease_token
    or v_object.lease_until is null or v_object.lease_until <= clock_timestamp() then
    raise exception using errcode = '40001', message = 'Source purge lease unavailable';
  end if;
  return v_object;
end;
$$;

-- This service-role RPC is intentionally the only way to expose an outbox object.
-- It never accepts an owner ID or caller-selected path; both values come from the
-- immutable purge record created by request_source_purge.
create function public.claim_source_purge_objects(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_object public.source_purge_objects%rowtype;
  v_purge public.source_purges%rowtype;
  v_candidate record;
  v_objects jsonb := '[]'::jsonb;
begin
  if not conuo_private.valid_id(p_worker_id)
    or p_limit is null or p_limit not between 1 and 10
    or p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception using errcode = '22023', message = 'Invalid source purge claim';
  end if;

  for v_candidate in
    select object.purge_id, object.storage_path
      from public.source_purge_objects object
      join public.source_purges purge on purge.purge_id = object.purge_id
      where (
        (object.state = 'pending' and object.next_attempt_at <= clock_timestamp())
        or (object.state = 'processing' and object.lease_until <= clock_timestamp())
      )
      and purge.state <> 'completed'
      order by object.next_attempt_at, object.created_at, object.purge_id, object.storage_path
      limit p_limit * 100
  loop
    select * into v_object
      from public.source_purge_objects object
      where object.purge_id = v_candidate.purge_id
        and object.storage_path = v_candidate.storage_path
        and (
          (object.state = 'pending' and object.next_attempt_at <= clock_timestamp())
          or (object.state = 'processing' and object.lease_until <= clock_timestamp())
        )
      for update skip locked;
    if not found then
      continue;
    end if;

    -- A crashed worker consumes an attempt as soon as it claims. Never issue an
    -- unbounded sequence of leases for a path that cannot be removed.
    if v_object.attempts >= 5 then
      update public.source_purge_objects
        set state = 'failed', worker_id = null, lease_token = null, lease_until = null,
            last_error = case when v_object.state = 'processing' then 'LEASE_EXPIRED' else 'ATTEMPTS_EXHAUSTED' end,
            updated_at = clock_timestamp()
        where purge_id = v_object.purge_id and storage_path = v_object.storage_path;
      perform conuo_private.refresh_source_purge_state(v_object.purge_id);
      continue;
    end if;

    update public.source_purge_objects
      set state = 'processing', attempts = attempts + 1, worker_id = p_worker_id,
          lease_token = gen_random_uuid(),
          lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
          last_error = null, updated_at = clock_timestamp()
      where purge_id = v_object.purge_id and storage_path = v_object.storage_path
      returning * into v_object;
    v_purge := conuo_private.refresh_source_purge_state(v_object.purge_id);
    v_objects := v_objects || jsonb_build_array(jsonb_build_object(
      'purgeId', v_object.purge_id,
      'ownerId', v_purge.owner_id,
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

create function public.heartbeat_source_purge_object(
  p_purge_id uuid,
  p_storage_path text,
  p_lease_token uuid,
  p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_object public.source_purge_objects%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception using errcode = '22023', message = 'Invalid source purge lease duration';
  end if;
  v_object := conuo_private.lock_source_purge_object(p_purge_id, p_storage_path, p_lease_token);
  update public.source_purge_objects
    set lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        updated_at = clock_timestamp()
    where purge_id = v_object.purge_id and storage_path = v_object.storage_path
    returning * into v_object;
  return jsonb_build_object('leaseUntil', v_object.lease_until);
end;
$$;

create function public.complete_source_purge_object(
  p_purge_id uuid,
  p_storage_path text,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_object public.source_purge_objects%rowtype;
  v_purge public.source_purges%rowtype;
begin
  v_object := conuo_private.lock_source_purge_object(p_purge_id, p_storage_path, p_lease_token);
  update public.source_purge_objects
    set state = 'completed', worker_id = null, lease_token = null, lease_until = null,
        last_error = null, completed_at = clock_timestamp(), updated_at = clock_timestamp()
    where purge_id = v_object.purge_id and storage_path = v_object.storage_path
    returning * into v_object;
  v_purge := conuo_private.refresh_source_purge_state(v_object.purge_id);
  return jsonb_build_object(
    'state', v_object.state,
    'purgeState', v_purge.state,
    'completedAt', v_object.completed_at
  );
end;
$$;

create function public.fail_source_purge_object(
  p_purge_id uuid,
  p_storage_path text,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_object public.source_purge_objects%rowtype;
  v_purge public.source_purges%rowtype;
  v_retry boolean;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' or p_retryable is null then
    raise exception using errcode = '22023', message = 'Invalid source purge failure';
  end if;
  v_object := conuo_private.lock_source_purge_object(p_purge_id, p_storage_path, p_lease_token);
  v_retry := p_retryable and v_object.attempts < 5;
  update public.source_purge_objects
    set state = case when v_retry then 'pending' else 'failed' end,
        worker_id = null, lease_token = null, lease_until = null,
        next_attempt_at = case
          when v_retry then clock_timestamp() + make_interval(secs => least(900, 15 * (2 ^ (v_object.attempts - 1))::integer))
          else next_attempt_at
        end,
        last_error = p_error_code,
        updated_at = clock_timestamp()
    where purge_id = v_object.purge_id and storage_path = v_object.storage_path
    returning * into v_object;
  v_purge := conuo_private.refresh_source_purge_state(v_object.purge_id);
  return jsonb_build_object(
    'state', v_object.state,
    'purgeState', v_purge.state,
    'nextAttemptAt', case when v_object.state = 'pending' then v_object.next_attempt_at else null end
  );
end;
$$;

-- User sessions cannot see original paths or manipulate worker leases. The worker
-- is privileged explicitly, while direct table rights remain revoked by migration 004.
revoke all on function conuo_private.refresh_source_purge_state(uuid),
  conuo_private.lock_source_purge_object(uuid,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_source_purge_objects(text,integer,integer),
  public.heartbeat_source_purge_object(uuid,text,uuid,integer),
  public.complete_source_purge_object(uuid,text,uuid),
  public.fail_source_purge_object(uuid,text,uuid,text,boolean)
  from public, anon, authenticated;
grant execute on function public.claim_source_purge_objects(text,integer,integer),
  public.heartbeat_source_purge_object(uuid,text,uuid,integer),
  public.complete_source_purge_object(uuid,text,uuid),
  public.fail_source_purge_object(uuid,text,uuid,text,boolean)
  to service_role;

commit;