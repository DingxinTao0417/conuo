-- Durable, server-owned execution for source analysis and knowledge drafts.
-- The workspace JSON remains the user-visible audit projection; this private
-- outbox owns retries, leases, staged results and browser-independent execution.
begin;

create table conuo_private.organization_jobs (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  job_id text not null check (job_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  request jsonb not null,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  context_digest text not null check (context_digest ~ '^[a-f0-9]{64}$'),
  model_request_id text not null check (model_request_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  state text not null check (state in ('queued','running','succeeded','failed','cancelled')),
  attempt integer not null default 0 check (attempt between 0 and 5),
  worker_id text check (worker_id is null or worker_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  result_digest text check (result_digest is null or result_digest ~ '^[a-f0-9]{64}$'),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  published_revision bigint,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  primary key (owner_id, job_id),
  unique (owner_id, model_request_id)
);

alter table conuo_private.organization_jobs enable row level security;
revoke all on table conuo_private.organization_jobs from public, anon, authenticated, service_role;

create index organization_jobs_dispatch
  on conuo_private.organization_jobs(state, next_attempt_at, lease_until, created_at, owner_id, job_id)
  where state in ('queued','running');

create function conuo_private.organization_timestamp()
returns text language sql volatile set search_path = '' as $$
  select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- `organizationJobs` is an execution/audit projection. Its own lifecycle must
-- not invalidate an otherwise identical source scope, while every other saved
-- workspace change remains a conservative context change for this first slice.
create function conuo_private.organization_context_digest(p_data jsonb, p_request jsonb)
returns text language sql immutable set search_path = '' as $$
  select encode(
    sha256(convert_to(jsonb_build_array(p_data - 'organizationJobs', p_request)::text, 'UTF8')),
    'hex'
  );
$$;

create function conuo_private.organization_job_projection(p_data jsonb, p_job_id text)
returns jsonb language sql immutable set search_path = '' as $$
  select job.value
  from jsonb_array_elements(
    case when jsonb_typeof(p_data->'organizationJobs') = 'array'
      then p_data->'organizationJobs' else '[]'::jsonb end
  ) as job(value)
  where job.value->>'id' = p_job_id
  limit 1;
$$;

create function conuo_private.replace_organization_job_projection(
  p_data jsonb,
  p_job_id text,
  p_replacement jsonb
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_jobs jsonb;
begin
  select coalesce(jsonb_agg(
    case when job.value->>'id' = p_job_id then p_replacement else job.value end
    order by job.ordinality
  ), '[]'::jsonb)
    into v_jobs
    from jsonb_array_elements(
      case when jsonb_typeof(p_data->'organizationJobs') = 'array'
        then p_data->'organizationJobs' else '[]'::jsonb end
    ) with ordinality as job(value, ordinality);
  return jsonb_set(p_data, '{organizationJobs}', v_jobs, true);
end;
$$;

create function conuo_private.remove_organization_job_projection(
  p_data jsonb,
  p_job_id text
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_jobs jsonb;
begin
  select coalesce(jsonb_agg(job.value order by job.ordinality), '[]'::jsonb)
    into v_jobs
    from jsonb_array_elements(
      case when jsonb_typeof(p_data->'organizationJobs') = 'array'
        then p_data->'organizationJobs' else '[]'::jsonb end
    ) with ordinality as job(value, ordinality)
    where job.value->>'id' is distinct from p_job_id;
  return jsonb_set(p_data, '{organizationJobs}', v_jobs, true);
end;
$$;

create function conuo_private.organization_terminal_projection(
  p_job jsonb,
  p_status text,
  p_error text default null,
  p_result jsonb default null
) returns jsonb language sql volatile set search_path = '' as $$
  select (p_job - 'error' - 'result') || jsonb_build_object(
    'status', p_status,
    'updatedAt', conuo_private.organization_timestamp()
  ) || case when p_error is null then '{}'::jsonb else jsonb_build_object('error', p_error) end
    || case when p_result is null then '{}'::jsonb else jsonb_build_object('result', p_result) end;
$$;

-- The public queue only supports bounded, source-grounded summaries and topic
-- drafts in this rollout. Existing update/relation interactions remain direct
-- requests until their target-revision protocol has a durable equivalent.
create function conuo_private.valid_organization_request(p_data jsonb, p_request jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
declare
  v_source_id text;
  v_version_id text;
  v_source jsonb;
  v_source_ids text[] := array[]::text[];
  v_count integer;
  v_space_id text;
begin
  if jsonb_typeof(p_data) <> 'object' or jsonb_typeof(p_request) <> 'object'
    or exists (
      select 1 from jsonb_object_keys(p_request) as entry(key)
      where key not in ('requestId','kind','trigger','spaceId','sourceIds','sourceVersions','topic')
    )
    or not conuo_private.valid_id(p_request->>'requestId')
    or p_request->>'kind' not in ('source','knowledge')
    or p_request->>'trigger' not in ('automatic','manual')
    or not conuo_private.valid_id(p_request->>'spaceId')
    or jsonb_typeof(p_request->'sourceIds') <> 'array'
    or jsonb_typeof(p_request->'sourceVersions') <> 'array'
    or jsonb_array_length(p_request->'sourceIds') not between 1 and 10
    or jsonb_array_length(p_request->'sourceVersions') <> jsonb_array_length(p_request->'sourceIds')
    or (p_request ? 'topic' and (
      jsonb_typeof(p_request->'topic') <> 'string' or length(btrim(p_request->>'topic')) > 200
    ))
    or (p_request->>'kind' = 'source' and jsonb_array_length(p_request->'sourceIds') <> 1)
    or (p_request->>'trigger' = 'automatic' and p_request->>'kind' <> 'source')
    or (p_request->>'trigger' = 'automatic' and p_data->>'autoOrganize' is distinct from 'true')
    or p_data->>'aiEnabled' is distinct from 'true' then
    return false;
  end if;

  v_space_id := p_request->>'spaceId';
  if v_space_id <> 'inbox' and not exists (
    select 1 from jsonb_array_elements(p_data->'spaces') as space(value)
    where space.value->>'id' = v_space_id and space.value->>'archived' is distinct from 'true'
  ) then
    return false;
  end if;

  for v_source_id in select value from jsonb_array_elements_text(p_request->'sourceIds') loop
    if not conuo_private.valid_id(v_source_id) or v_source_id = any(v_source_ids) then
      return false;
    end if;
    v_source_ids := array_append(v_source_ids, v_source_id);
    select count(*) into v_count
      from jsonb_array_elements(p_request->'sourceVersions') as version(value)
      where version.value->>'sourceId' = v_source_id
        and jsonb_typeof(version.value) = 'object'
        and conuo_private.valid_id(version.value->>'versionId');
    if v_count <> 1 then return false; end if;
    select version.value->>'versionId' into v_version_id
      from jsonb_array_elements(p_request->'sourceVersions') as version(value)
      where version.value->>'sourceId' = v_source_id;
    select source.value into v_source
      from jsonb_array_elements(p_data->'sources') as source(value)
      where source.value->>'id' = v_source_id
      limit 1;
    if v_source is null
      or v_source->>'versionId' is distinct from v_version_id
      or v_source->>'deletedAt' is not null
      or v_source->>'aiAllowed' is distinct from 'true'
      or v_source->>'status' not in ('ready','partial')
      or length(btrim(coalesce(v_source->>'text',''))) = 0
      or jsonb_typeof(v_source->'chunks') <> 'array'
      or jsonb_array_length(v_source->'chunks') = 0 then
      return false;
    end if;
    if (v_space_id = 'inbox' and jsonb_array_length(v_source->'spaceIds') <> 0)
      or (v_space_id <> 'inbox' and not exists (
        select 1 from jsonb_array_elements_text(v_source->'spaceIds') as membership(value)
        where membership.value = v_space_id
      )) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create function conuo_private.assert_organization_context(
  p_data jsonb,
  p_request jsonb,
  p_context_digest text
) returns void language plpgsql stable set search_path = '' as $$
begin
  if not conuo_private.valid_organization_request(p_data, p_request)
    or conuo_private.organization_context_digest(p_data, p_request) is distinct from p_context_digest then
    raise exception using errcode = '40001', message = 'Organization context changed';
  end if;
end;
$$;

create function public.enqueue_organization_job(
  p_request jsonb,
  p_expected_revision bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_job conuo_private.organization_jobs%rowtype;
  v_projection jsonb;
  v_next_data jsonb;
  v_request_digest text;
  v_context_digest text;
  v_revision bigint;
  v_now text;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception using errcode = '22023', message = 'Invalid organization enqueue';
  end if;
  perform conuo_private.owner_lock(v_owner);
  select * into v_workspace from public.workspaces workspace where workspace.owner_id = v_owner for update;
  if not found or v_workspace.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  if not conuo_private.valid_organization_request(v_workspace.data, p_request) then
    raise exception using errcode = '22023', message = 'Organization request is unavailable';
  end if;
  v_request_digest := encode(sha256(convert_to(p_request::text, 'UTF8')), 'hex');
  select * into v_job from conuo_private.organization_jobs job
    where job.owner_id = v_owner and job.job_id = p_request->>'requestId' for update;
  if found then
    if v_job.request_digest <> v_request_digest then
      raise exception using errcode = '40001', message = 'Organization request changed';
    end if;
    v_projection := conuo_private.organization_job_projection(v_workspace.data, v_job.job_id);
    if v_projection is null then
      raise exception using errcode = '40001', message = 'Organization projection unavailable';
    end if;
    return jsonb_build_object('revision', v_workspace.revision, 'job', v_projection, 'created', false);
  end if;
  if coalesce(jsonb_array_length(v_workspace.data->'organizationJobs'), 0) >= 1000 then
    raise exception using errcode = '22023', message = 'Organization job limit reached';
  end if;
  v_context_digest := conuo_private.organization_context_digest(v_workspace.data, p_request);
  v_now := conuo_private.organization_timestamp();
  v_projection := jsonb_build_object(
    'id', p_request->>'requestId',
    'durable', true,
    'request', p_request,
    'status', 'queued',
    'createdAt', v_now,
    'updatedAt', v_now
  );
  insert into conuo_private.organization_jobs(
    owner_id, job_id, request, request_digest, context_digest, model_request_id, state
  ) values (
    v_owner, p_request->>'requestId', p_request, v_request_digest, v_context_digest,
    p_request->>'requestId', 'queued'
  );
  v_next_data := jsonb_set(
    v_workspace.data,
    '{organizationJobs}',
    coalesce(v_workspace.data->'organizationJobs', '[]'::jsonb) || jsonb_build_array(v_projection),
    true
  );
  update public.workspaces workspace set
    data = v_next_data, revision = workspace.revision + 1, updated_at = clock_timestamp()
    where workspace.owner_id = v_owner and workspace.revision = v_workspace.revision
    returning workspace.revision into v_revision;
  if v_revision is null then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  return jsonb_build_object('revision', v_revision, 'job', v_projection, 'created', true);
end;
$$;

create function public.claim_organization_jobs(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_candidate record;
  v_workspace public.workspaces%rowtype;
  v_job conuo_private.organization_jobs%rowtype;
  v_projection jsonb;
  v_data jsonb;
  v_revision bigint;
  v_jobs jsonb := '[]'::jsonb;
begin
  if p_worker_id is null or p_worker_id !~ '^[a-zA-Z0-9_-]{1,80}$'
    or p_limit is null or p_limit not between 1 and 5
    or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception using errcode = '22023', message = 'Invalid organization claim';
  end if;

  for v_candidate in
    select owner_id, job_id
    from conuo_private.organization_jobs
    where (state = 'queued' and next_attempt_at <= clock_timestamp())
      or (state = 'running' and lease_until is not null and lease_until <= clock_timestamp()
        and next_attempt_at <= clock_timestamp())
    order by next_attempt_at, created_at, owner_id, job_id
    limit p_limit * 100
  loop
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended('conuo:source:' || v_candidate.owner_id::text, 0)
    ) then
      continue;
    end if;
    perform conuo_private.assert_account_access(v_candidate.owner_id);
    select * into v_workspace from public.workspaces workspace
      where workspace.owner_id = v_candidate.owner_id for update;
    if not found then
      delete from conuo_private.organization_jobs
        where owner_id = v_candidate.owner_id and job_id = v_candidate.job_id;
      continue;
    end if;
    -- `ai_requests` permits one provider call per account. Keep that invariant
    -- at queue-claim time too: the per-owner advisory/workspace lock above
    -- serializes concurrent workers, while this check prevents a second worker
    -- (or another item in the same batch) from leasing a different task before
    -- the first lease has reached a terminal state or expired.
    if exists (
      select 1
      from conuo_private.organization_jobs active
      where active.owner_id = v_candidate.owner_id
        and active.job_id <> v_candidate.job_id
        and active.state = 'running'
        and active.lease_until > clock_timestamp()
    ) then
      continue;
    end if;
    select * into v_job from conuo_private.organization_jobs job
      where job.owner_id = v_candidate.owner_id and job.job_id = v_candidate.job_id
        and ((job.state = 'queued' and job.next_attempt_at <= clock_timestamp())
          or (job.state = 'running' and job.lease_until is not null
            and job.lease_until <= clock_timestamp() and job.next_attempt_at <= clock_timestamp()))
      for update skip locked;
    if not found then
      continue;
    end if;
    v_projection := conuo_private.organization_job_projection(v_workspace.data, v_job.job_id);
    if v_projection is null then
      delete from conuo_private.organization_jobs
        where owner_id = v_job.owner_id and job_id = v_job.job_id;
      continue;
    end if;
    if not conuo_private.valid_organization_request(v_workspace.data, v_job.request)
      or conuo_private.organization_context_digest(v_workspace.data, v_job.request)
        is distinct from v_job.context_digest then
      update conuo_private.organization_jobs job set
        state = 'cancelled', worker_id = null, lease_token = null, lease_until = null,
        result = null, result_digest = null, error_code = 'ORGANIZATION_CONTEXT_CHANGED',
        completed_at = clock_timestamp(), updated_at = clock_timestamp()
        where job.owner_id = v_job.owner_id and job.job_id = v_job.job_id;
      v_data := conuo_private.replace_organization_job_projection(
        v_workspace.data,
        v_job.job_id,
        conuo_private.organization_terminal_projection(
          v_projection,
          'cancelled',
          '资料、版本或 AI 设置已改变，后台整理已停止。'
        )
      );
      update public.workspaces workspace set data = v_data, revision = revision + 1,
        updated_at = clock_timestamp()
        where workspace.owner_id = v_job.owner_id and workspace.revision = v_workspace.revision
        returning revision into v_revision;
      continue;
    end if;
    if v_job.result is null and v_job.attempt >= 5 then
      update conuo_private.organization_jobs job set
        state = 'failed', worker_id = null, lease_token = null, lease_until = null,
        error_code = 'ATTEMPTS_EXHAUSTED', completed_at = clock_timestamp(), updated_at = clock_timestamp()
        where job.owner_id = v_job.owner_id and job.job_id = v_job.job_id;
      v_data := conuo_private.replace_organization_job_projection(
        v_workspace.data,
        v_job.job_id,
        conuo_private.organization_terminal_projection(
          v_projection,
          'failed',
          '后台整理多次未完成，请稍后重新生成。'
        )
      );
      update public.workspaces workspace set data = v_data, revision = revision + 1,
        updated_at = clock_timestamp()
        where workspace.owner_id = v_job.owner_id and workspace.revision = v_workspace.revision
        returning revision into v_revision;
      continue;
    end if;
    update conuo_private.organization_jobs job set
      state = 'running',
      attempt = case when job.result is null then job.attempt + 1 else job.attempt end,
      worker_id = p_worker_id,
      lease_token = gen_random_uuid(),
      lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      error_code = null,
      updated_at = clock_timestamp()
      where job.owner_id = v_job.owner_id and job.job_id = v_job.job_id
      returning * into v_job;
    v_jobs := v_jobs || jsonb_build_array(jsonb_build_object(
      'jobId', v_job.job_id,
      'ownerId', v_job.owner_id,
      'leaseToken', v_job.lease_token,
      'leaseUntil', v_job.lease_until,
      'hasResult', v_job.result is not null,
      'attempt', v_job.attempt
    ));
    exit when jsonb_array_length(v_jobs) >= p_limit;
  end loop;
  return jsonb_build_object('jobs', v_jobs);
end;
$$;

create function conuo_private.lock_organization_job(
  p_owner uuid,
  p_job_id text,
  p_lease_token uuid
) returns conuo_private.organization_jobs language plpgsql set search_path = '' as $$
declare
  v_job conuo_private.organization_jobs%rowtype;
begin
  if p_owner is null or not conuo_private.valid_id(p_job_id) or p_lease_token is null then
    raise exception using errcode = '22023', message = 'Invalid organization lease';
  end if;
  perform conuo_private.owner_lock(p_owner);
  select * into v_job from conuo_private.organization_jobs job
    where job.owner_id = p_owner and job.job_id = p_job_id for update;
  if not found or v_job.state <> 'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_until is null or v_job.lease_until <= clock_timestamp() then
    raise exception using errcode = '40001', message = 'Organization lease unavailable';
  end if;
  return v_job;
end;
$$;

create function public.read_organization_job_context(
  p_owner uuid,
  p_job_id text,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job conuo_private.organization_jobs%rowtype;
  v_workspace public.workspaces%rowtype;
begin
  v_job := conuo_private.lock_organization_job(p_owner, p_job_id, p_lease_token);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_job.owner_id for update;
  if not found then
    raise exception using errcode = '40001', message = 'Organization workspace unavailable';
  end if;
  perform conuo_private.assert_organization_context(
    v_workspace.data, v_job.request, v_job.context_digest
  );
  return jsonb_build_object(
    'jobId', v_job.job_id,
    'ownerId', v_job.owner_id,
    'leaseToken', v_job.lease_token,
    'leaseUntil', v_job.lease_until,
    'request', v_job.request,
    'workspace', v_workspace.data,
    'contextDigest', v_job.context_digest,
    'result', v_job.result
  );
end;
$$;

create function public.heartbeat_organization_job(
  p_owner uuid,
  p_job_id text,
  p_lease_token uuid,
  p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job conuo_private.organization_jobs%rowtype;
  v_workspace public.workspaces%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception using errcode = '22023', message = 'Invalid organization heartbeat';
  end if;
  v_job := conuo_private.lock_organization_job(p_owner, p_job_id, p_lease_token);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_job.owner_id for update;
  if not found then
    raise exception using errcode = '40001', message = 'Organization workspace unavailable';
  end if;
  perform conuo_private.assert_organization_context(
    v_workspace.data, v_job.request, v_job.context_digest
  );
  update conuo_private.organization_jobs job set
    lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
    updated_at = clock_timestamp()
    where job.owner_id = v_job.owner_id and job.job_id = v_job.job_id
      and job.lease_token = p_lease_token
    returning lease_until into v_job.lease_until;
  if v_job.lease_until is null then
    raise exception using errcode = '40001', message = 'Organization lease unavailable';
  end if;
  return jsonb_build_object('leaseUntil', v_job.lease_until);
end;
$$;

create function public.stage_organization_job_result(
  p_owner uuid,
  p_job_id text,
  p_lease_token uuid,
  p_result jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job conuo_private.organization_jobs%rowtype;
  v_workspace public.workspaces%rowtype;
  v_digest text;
begin
  if p_result is null or jsonb_typeof(p_result) <> 'object'
    or octet_length(p_result::text) > 245760 then
    raise exception using errcode = '22023', message = 'Invalid organization result';
  end if;
  v_job := conuo_private.lock_organization_job(p_owner, p_job_id, p_lease_token);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_job.owner_id for update;
  if not found then
    raise exception using errcode = '40001', message = 'Organization workspace unavailable';
  end if;
  perform conuo_private.assert_organization_context(
    v_workspace.data, v_job.request, v_job.context_digest
  );
  v_digest := encode(sha256(convert_to(p_result::text, 'UTF8')), 'hex');
  update conuo_private.organization_jobs job set
    result = p_result, result_digest = v_digest, error_code = null, updated_at = clock_timestamp()
    where job.owner_id = v_job.owner_id and job.job_id = v_job.job_id
      and job.lease_token = p_lease_token;
  return jsonb_build_object('staged', true, 'resultDigest', v_digest);
end;
$$;

create function public.publish_organization_job(
  p_owner uuid,
  p_job_id text,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job conuo_private.organization_jobs%rowtype;
  v_workspace public.workspaces%rowtype;
  v_projection jsonb;
  v_ready jsonb;
  v_data jsonb;
  v_revision bigint;
begin
  v_job := conuo_private.lock_organization_job(p_owner, p_job_id, p_lease_token);
  if v_job.result is null or v_job.result_digest is null then
    raise exception using errcode = '40001', message = 'Organization result unavailable';
  end if;
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_job.owner_id for update;
  if not found then
    raise exception using errcode = '40001', message = 'Organization workspace unavailable';
  end if;
  if not conuo_private.valid_organization_request(v_workspace.data, v_job.request)
    or conuo_private.organization_context_digest(v_workspace.data, v_job.request)
      is distinct from v_job.context_digest then
    v_projection := conuo_private.organization_job_projection(v_workspace.data, v_job.job_id);
    update conuo_private.organization_jobs job set
      state = 'cancelled', worker_id = null, lease_token = null, lease_until = null,
      result = null, result_digest = null, error_code = 'ORGANIZATION_CONTEXT_CHANGED',
      completed_at = clock_timestamp(), updated_at = clock_timestamp()
      where job.owner_id = v_job.owner_id and job.job_id = v_job.job_id;
    if v_projection is not null then
      v_data := conuo_private.replace_organization_job_projection(
        v_workspace.data,
        v_job.job_id,
        conuo_private.organization_terminal_projection(
          v_projection,
          'cancelled',
          '资料、版本或 AI 设置已改变，后台整理已停止。'
        )
      );
      update public.workspaces workspace set data = v_data, revision = revision + 1,
        updated_at = clock_timestamp()
        where workspace.owner_id = v_job.owner_id and workspace.revision = v_workspace.revision
        returning revision into v_revision;
    end if;
    return jsonb_build_object('state', 'cancelled', 'revision', v_revision);
  end if;
  v_projection := conuo_private.organization_job_projection(v_workspace.data, v_job.job_id);
  if v_projection is null or v_projection->'request' is distinct from v_job.request
    or v_projection->>'durable' is distinct from 'true' then
    raise exception using errcode = '40001', message = 'Organization projection unavailable';
  end if;
  v_ready := conuo_private.organization_terminal_projection(v_projection, 'ready', null, v_job.result);
  v_data := conuo_private.replace_organization_job_projection(v_workspace.data, v_job.job_id, v_ready);
  if octet_length(v_data::text) > 3145728 then
    update conuo_private.organization_jobs job set
      worker_id = null, lease_token = null, lease_until = null,
      next_attempt_at = clock_timestamp() + interval '5 minutes',
      error_code = 'RESULT_NOT_PUBLISHED_CAPACITY', updated_at = clock_timestamp()
      where job.owner_id = v_job.owner_id and job.job_id = v_job.job_id;
    return jsonb_build_object('state', 'pending_capacity');
  end if;
  -- Update the private state before the workspace write. If the latter fails the
  -- transaction rolls both back; the lifecycle trigger must not cancel this
  -- legitimate terminal projection while it observes the row.
  update conuo_private.organization_jobs job set
    state = 'succeeded', worker_id = null, lease_token = null, lease_until = null,
    error_code = null, published_revision = v_workspace.revision + 1,
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
    where job.owner_id = v_job.owner_id and job.job_id = v_job.job_id;
  update public.workspaces workspace set data = v_data, revision = revision + 1,
    updated_at = clock_timestamp()
    where workspace.owner_id = v_job.owner_id and workspace.revision = v_workspace.revision
    returning revision into v_revision;
  if v_revision is null then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  return jsonb_build_object('state', 'succeeded', 'revision', v_revision);
end;
$$;

create function public.fail_organization_job(
  p_owner uuid,
  p_job_id text,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job conuo_private.organization_jobs%rowtype;
  v_workspace public.workspaces%rowtype;
  v_projection jsonb;
  v_data jsonb;
  v_revision bigint;
  v_retry boolean;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' or p_retryable is null then
    raise exception using errcode = '22023', message = 'Invalid organization failure';
  end if;
  v_job := conuo_private.lock_organization_job(p_owner, p_job_id, p_lease_token);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_job.owner_id for update;
  if not found then
    raise exception using errcode = '40001', message = 'Organization workspace unavailable';
  end if;
  if not conuo_private.valid_organization_request(v_workspace.data, v_job.request)
    or conuo_private.organization_context_digest(v_workspace.data, v_job.request)
      is distinct from v_job.context_digest then
    update conuo_private.organization_jobs job set
      state = 'cancelled', worker_id = null, lease_token = null, lease_until = null,
      result = null, result_digest = null, error_code = 'ORGANIZATION_CONTEXT_CHANGED',
      completed_at = clock_timestamp(), updated_at = clock_timestamp()
      where job.owner_id = v_job.owner_id and job.job_id = v_job.job_id;
    v_projection := conuo_private.organization_job_projection(v_workspace.data, v_job.job_id);
    if v_projection is not null then
      v_data := conuo_private.replace_organization_job_projection(
        v_workspace.data,
        v_job.job_id,
        conuo_private.organization_terminal_projection(
          v_projection,
          'cancelled',
          '资料、版本或 AI 设置已改变，后台整理已停止。'
        )
      );
      update public.workspaces workspace set data = v_data, revision = revision + 1,
        updated_at = clock_timestamp()
        where workspace.owner_id = v_job.owner_id and workspace.revision = v_workspace.revision
        returning revision into v_revision;
    end if;
    return jsonb_build_object('state', 'cancelled', 'revision', v_revision);
  end if;
  v_retry := p_retryable and v_job.result is null and v_job.attempt < 5;
  if v_retry then
    update conuo_private.organization_jobs job set
      state = 'queued', worker_id = null, lease_token = null, lease_until = null,
      next_attempt_at = clock_timestamp() + make_interval(
        secs => least(900, 15 * (2 ^ greatest(v_job.attempt - 1, 0))::integer)
      ),
      error_code = p_error_code, updated_at = clock_timestamp()
      where job.owner_id = v_job.owner_id and job.job_id = v_job.job_id;
    return jsonb_build_object('state', 'queued');
  end if;
  update conuo_private.organization_jobs job set
    state = 'failed', worker_id = null, lease_token = null, lease_until = null,
    result = null, result_digest = null, error_code = p_error_code,
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
    where job.owner_id = v_job.owner_id and job.job_id = v_job.job_id;
  v_projection := conuo_private.organization_job_projection(v_workspace.data, v_job.job_id);
  if v_projection is not null then
    v_data := conuo_private.replace_organization_job_projection(
      v_workspace.data,
      v_job.job_id,
      conuo_private.organization_terminal_projection(
        v_projection,
        'failed',
        '后台整理未完成，请稍后重新生成。'
      )
    );
    update public.workspaces workspace set data = v_data, revision = revision + 1,
      updated_at = clock_timestamp()
      where workspace.owner_id = v_job.owner_id and workspace.revision = v_workspace.revision
      returning revision into v_revision;
  end if;
  return jsonb_build_object('state', 'failed', 'revision', v_revision);
end;
$$;

create function public.cancel_organization_job(
  p_job_id text,
  p_expected_revision bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_job conuo_private.organization_jobs%rowtype;
  v_projection jsonb;
  v_data jsonb;
  v_revision bigint;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not conuo_private.valid_id(p_job_id) or p_expected_revision is null or p_expected_revision < 1 then
    raise exception using errcode = '22023', message = 'Invalid organization cancellation';
  end if;
  perform conuo_private.owner_lock(v_owner);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_owner for update;
  if not found or v_workspace.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  select * into v_job from conuo_private.organization_jobs job
    where job.owner_id = v_owner and job.job_id = p_job_id for update;
  if not found then
    raise exception using errcode = '40001', message = 'Organization task unavailable';
  end if;
  v_projection := conuo_private.organization_job_projection(v_workspace.data, v_job.job_id);
  if v_projection is null then
    raise exception using errcode = '40001', message = 'Organization projection unavailable';
  end if;
  if v_job.state in ('succeeded','failed','cancelled') then
    return jsonb_build_object('revision', v_workspace.revision, 'job', v_projection, 'cancelled', false);
  end if;
  update conuo_private.organization_jobs job set
    state = 'cancelled', worker_id = null, lease_token = null, lease_until = null,
    result = null, result_digest = null, error_code = 'CANCELLED_BY_USER',
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
    where job.owner_id = v_owner and job.job_id = v_job.job_id;
  v_data := conuo_private.replace_organization_job_projection(
    v_workspace.data,
    v_job.job_id,
    conuo_private.organization_terminal_projection(
      v_projection,
      'cancelled',
      '后台整理已停止，可稍后重新生成。'
    )
  );
  update public.workspaces workspace set data = v_data, revision = revision + 1,
    updated_at = clock_timestamp()
    where workspace.owner_id = v_owner and workspace.revision = v_workspace.revision
    returning revision into v_revision;
  if v_revision is null then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  return jsonb_build_object(
    'revision', v_revision,
    'job', conuo_private.organization_terminal_projection(
      v_projection, 'cancelled', '后台整理已停止，可稍后重新生成。'
    ),
    'cancelled', true
  );
end;
$$;

-- A browser can recover a queued durable projection after an upgrade, backup,
-- or interrupted sync without guessing whether a server worker still owns it.
create function public.reconcile_organization_jobs()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_projection record;
  v_task conuo_private.organization_jobs%rowtype;
  v_data jsonb;
  v_changed boolean := false;
  v_revision bigint;
  v_statuses jsonb;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  perform conuo_private.owner_lock(v_owner);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_owner for update;
  if not found then
    raise exception using errcode = '40001', message = 'Organization workspace unavailable';
  end if;
  v_data := v_workspace.data;
  for v_projection in
    select item.value as job
    from jsonb_array_elements(
      case when jsonb_typeof(v_workspace.data->'organizationJobs') = 'array'
        then v_workspace.data->'organizationJobs' else '[]'::jsonb end
    ) as item(value)
    where item.value->>'durable' = 'true'
      and item.value->>'status' in ('queued','running')
  loop
    select * into v_task from conuo_private.organization_jobs task
      where task.owner_id = v_owner and task.job_id = v_projection.job->>'id';
    if not found then
      v_data := conuo_private.replace_organization_job_projection(
        v_data,
        v_projection.job->>'id',
        conuo_private.organization_terminal_projection(
          v_projection.job,
          'cancelled',
          '云端任务记录已不可用，未继续处理。'
        )
      );
      v_changed := true;
    elsif v_task.state = 'failed' then
      v_data := conuo_private.replace_organization_job_projection(
        v_data,
        v_projection.job->>'id',
        conuo_private.organization_terminal_projection(
          v_projection.job,
          'failed',
          '后台整理未完成，请稍后重新生成。'
        )
      );
      v_changed := true;
    elsif v_task.state = 'cancelled' then
      v_data := conuo_private.replace_organization_job_projection(
        v_data,
        v_projection.job->>'id',
        conuo_private.organization_terminal_projection(
          v_projection.job,
          'cancelled',
          '后台整理已停止，可稍后重新生成。'
        )
      );
      v_changed := true;
    end if;
  end loop;
  if v_changed then
    update public.workspaces workspace set data = v_data, revision = revision + 1,
      updated_at = clock_timestamp()
      where workspace.owner_id = v_owner and workspace.revision = v_workspace.revision
      returning revision into v_revision;
  else
    v_revision := v_workspace.revision;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', task.job_id,
    'state', task.state,
    'updatedAt', task.updated_at
  ) order by task.created_at, task.job_id), '[]'::jsonb)
    into v_statuses
    from conuo_private.organization_jobs task
    where task.owner_id = v_owner and task.state in ('queued','running');
  return jsonb_build_object('revision', v_revision, 'jobs', v_statuses);
end;
$$;

-- Ordinary saves are full snapshots. Active outbox rows are therefore fenced
-- before any browser can replace their queued/running audit projection with a
-- stale copy, delete it, or inject an unreviewed result.
create function conuo_private.assert_organization_jobs_unchanged(
  p_owner uuid,
  p_old_data jsonb,
  p_new_data jsonb
) returns void language plpgsql stable set search_path = '' as $$
declare
  v_task conuo_private.organization_jobs%rowtype;
  v_old_projection jsonb;
  v_new_projection jsonb;
begin
  for v_task in
    select * from conuo_private.organization_jobs task
    where task.owner_id = p_owner and task.state in ('queued','running')
  loop
    v_old_projection := conuo_private.organization_job_projection(p_old_data, v_task.job_id);
    v_new_projection := conuo_private.organization_job_projection(p_new_data, v_task.job_id);
    if v_old_projection is null or v_new_projection is null
      or v_old_projection is distinct from v_new_projection then
      raise exception using errcode = '40001', message = 'Organization task projection changed';
    end if;
  end loop;
end;
$$;

-- A source purge and a normal settings/source save both write `workspaces`
-- directly in existing migrations. This trigger cancels or removes the private
-- outbox in that same transaction, so a late worker cannot disclose old source
-- text after a change of eligibility or permanent deletion.
create function conuo_private.fence_organization_jobs_on_workspace_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_task conuo_private.organization_jobs%rowtype;
  v_projection jsonb;
begin
  if new.data is not distinct from old.data then return new; end if;
  for v_task in
    select * from conuo_private.organization_jobs task
    where task.owner_id = new.owner_id and task.state in ('queued','running')
  loop
    v_projection := conuo_private.organization_job_projection(new.data, v_task.job_id);
    if v_projection is null then
      delete from conuo_private.organization_jobs task
        where task.owner_id = v_task.owner_id and task.job_id = v_task.job_id;
    elsif not conuo_private.valid_organization_request(new.data, v_task.request)
      or conuo_private.organization_context_digest(new.data, v_task.request)
        is distinct from v_task.context_digest then
      update conuo_private.organization_jobs task set
        state = 'cancelled', worker_id = null, lease_token = null, lease_until = null,
        result = null, result_digest = null, error_code = 'ORGANIZATION_CONTEXT_CHANGED',
        completed_at = clock_timestamp(), updated_at = clock_timestamp()
        where task.owner_id = v_task.owner_id and task.job_id = v_task.job_id;
      new.data := conuo_private.replace_organization_job_projection(
        new.data,
        v_task.job_id,
        conuo_private.organization_terminal_projection(
          v_projection,
          'cancelled',
          '资料、版本或 AI 设置已改变，后台整理已停止。'
        )
      );
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists fence_organization_jobs_on_workspace_update on public.workspaces;
create trigger fence_organization_jobs_on_workspace_update
before update of data on public.workspaces
for each row execute function conuo_private.fence_organization_jobs_on_workspace_update();

-- Deletion inserts its terminal fence after it has serialized all owner work.
-- Clearing the outbox here makes every subsequent worker RPC fail before it can
-- read a source snapshot, while the workspace/user cascade remains authoritative.
create function conuo_private.fence_account_deletion_organization_jobs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from conuo_private.organization_jobs where owner_id = new.owner_id;
  return new;
end;
$$;

drop trigger if exists fence_account_deletion_organization_jobs on public.account_deletions;
create trigger fence_account_deletion_organization_jobs
after insert on public.account_deletions
for each row execute function conuo_private.fence_account_deletion_organization_jobs();

-- Preserve the final fast-save implementation, adding only the active durable
-- job fence. The trigger above then handles legitimate context invalidation.
create or replace function public.save_workspace(p_data jsonb, p_expected_revision bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_revision bigint;
  v_project_workspace boolean := true;
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
  perform conuo_private.assert_account_access(v_owner);
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('conuo:source:' || v_owner::text, 0)
  ) then
    raise exception using errcode = '55P03', message = 'Workspace write busy';
  end if;
  perform conuo_private.assert_account_access(v_owner);
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
    perform conuo_private.assert_organization_jobs_unchanged(
      v_owner, v_workspace.data, p_data
    );
    v_project_workspace :=
      conuo_private.workspace_retrieval_projection_input(v_workspace.data)
      is distinct from
      conuo_private.workspace_retrieval_projection_input(p_data);
    update public.workspaces workspace
      set data = p_data, revision = workspace.revision + 1, updated_at = clock_timestamp()
      where workspace.owner_id = v_owner and workspace.revision = p_expected_revision
      returning workspace.revision into v_revision;
  end if;
  if v_revision is null then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  if v_project_workspace then
    perform conuo_private.project_workspace(v_owner, p_data);
  end if;
  return v_revision;
end;
$$;

revoke all on function conuo_private.organization_timestamp(),
  conuo_private.organization_context_digest(jsonb,jsonb),
  conuo_private.organization_job_projection(jsonb,text),
  conuo_private.replace_organization_job_projection(jsonb,text,jsonb),
  conuo_private.remove_organization_job_projection(jsonb,text),
  conuo_private.organization_terminal_projection(jsonb,text,text,jsonb),
  conuo_private.valid_organization_request(jsonb,jsonb),
  conuo_private.assert_organization_context(jsonb,jsonb,text),
  conuo_private.lock_organization_job(uuid,text,uuid),
  conuo_private.assert_organization_jobs_unchanged(uuid,jsonb,jsonb),
  conuo_private.fence_organization_jobs_on_workspace_update(),
  conuo_private.fence_account_deletion_organization_jobs()
  from public, anon, authenticated, service_role;

revoke all on function public.enqueue_organization_job(jsonb,bigint),
  public.cancel_organization_job(text,bigint),
  public.reconcile_organization_jobs(),
  public.claim_organization_jobs(text,integer,integer),
  public.read_organization_job_context(uuid,text,uuid),
  public.heartbeat_organization_job(uuid,text,uuid,integer),
  public.stage_organization_job_result(uuid,text,uuid,jsonb),
  public.publish_organization_job(uuid,text,uuid),
  public.fail_organization_job(uuid,text,uuid,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_organization_job(jsonb,bigint),
  public.cancel_organization_job(text,bigint),
  public.reconcile_organization_jobs()
  to authenticated;
grant execute on function public.claim_organization_jobs(text,integer,integer),
  public.read_organization_job_context(uuid,text,uuid),
  public.heartbeat_organization_job(uuid,text,uuid,integer),
  public.stage_organization_job_result(uuid,text,uuid,jsonb),
  public.publish_organization_job(uuid,text,uuid),
  public.fail_organization_job(uuid,text,uuid,text,boolean)
  to service_role;
revoke all on function public.save_workspace(jsonb,bigint) from public, anon, service_role;
grant execute on function public.save_workspace(jsonb,bigint) to authenticated;

commit;
