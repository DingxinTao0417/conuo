-- Account deletion is a terminal access fence. Cancel queued or leased embedding
-- work in the same transaction that creates the durable deletion record, then make
-- every later eligibility check return false for that owner. This prevents a worker
-- from receiving source text after the user has confirmed deletion.
begin;

create or replace function conuo_private.embedding_eligible(p_owner uuid, p_source text, p_version text)
returns boolean language sql stable set search_path = '' as $$
  select not conuo_private.account_deletion_blocked(p_owner) and exists (
    select 1 from public.sources s
    join public.workspaces w on w.owner_id = s.owner_id
    join public.source_versions v on v.owner_id=s.owner_id and v.source_id=s.source_id
      and v.version_id=s.current_version_id
    where s.owner_id=p_owner and s.source_id=p_source and s.current_version_id=p_version
      and s.retained and v.retained and s.deleted_at is null and s.ai_allowed
      and w.data->>'aiEnabled'='true' and w.data->>'semanticSearch'='true'
      and v.status in ('ready','partial')
      and conuo_private.in_scope(w.data->'spaces',s.space_ids,'*')
      and exists (select 1 from public.source_chunks c where c.owner_id=s.owner_id
        and c.source_id=s.source_id and c.version_id=s.current_version_id)
  );
$$;

create function conuo_private.fence_account_deletion_embedding_jobs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- The insertion happens after prepare_account_deletion has acquired the owner
  -- advisory lock. A worker that already held that lock has finished before this
  -- point; a leased worker afterwards loses its lease and cannot read another batch.
  update public.embedding_jobs job set
    state = 'cancelled',
    cancel_reason = 'ineligible',
    error_code = 'ACCOUNT_DELETION_PENDING',
    worker_id = null,
    lease_token = null,
    lease_until = null,
    updated_at = clock_timestamp()
  where job.owner_id = new.owner_id and job.state in ('queued', 'running', 'failed');

  -- Do not leave a published semantic result available through a future accidental
  -- route bypass while the terminal deletion record remains in place.
  update public.chunk_embeddings embedding set published = false
  from public.embedding_jobs job
  where job.owner_id = new.owner_id and embedding.job_id = job.job_id and embedding.published;

  -- A model call already dispatched to a provider cannot be recalled by the
  -- database. Its ledger result can, however, be removed immediately and its
  -- later completion fenced by finish_ai_request below.
  update public.ai_requests request set
    state = 'failed',
    result = null,
    error_code = 'ACCOUNT_DELETION_PENDING',
    updated_at = clock_timestamp()
  where request.owner_id = new.owner_id and (request.state = 'running' or request.result is not null);
  delete from public.embedding_usage usage where usage.owner_id = new.owner_id;
  return new;
end;
$$;

drop trigger if exists fence_account_deletion_embedding_jobs on public.account_deletions;
create trigger fence_account_deletion_embedding_jobs
after insert on public.account_deletions
for each row execute function conuo_private.fence_account_deletion_embedding_jobs();

create or replace function public.reserve_embedding_usage(
  p_owner_id uuid,
  p_request_id text,
  p_characters integer,
  p_daily_char_limit integer default 200000
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_day date := (clock_timestamp() at time zone 'UTC')::date; used bigint;
begin
  if p_owner_id is null or not conuo_private.valid_id(p_request_id) or p_characters is null
    or p_characters not between 1 and 200000 or p_daily_char_limit is null
    or p_daily_char_limit not between 1 and 10000000 then
    raise exception using errcode='22023', message='Invalid embedding usage reservation';
  end if;
  perform conuo_private.assert_account_access(p_owner_id);
  perform pg_advisory_xact_lock(hashtextextended('conuo:embedding-usage:' || p_owner_id::text,0));
  if exists(select 1 from public.embedding_usage where owner_id=p_owner_id and request_id=p_request_id) then
    return jsonb_build_object('allowed',false);
  end if;
  select coalesce(sum(characters),0) into used from public.embedding_usage where owner_id=p_owner_id and usage_date=v_day;
  if used+p_characters>p_daily_char_limit then return jsonb_build_object('allowed',false); end if;
  insert into public.embedding_usage(owner_id,request_id,usage_date,characters)
    values(p_owner_id,p_request_id,v_day,p_characters);
  return jsonb_build_object('allowed',true);
end;
$$;

create or replace function public.reserve_ai_request(
  p_owner uuid,
  p_request_id text,
  p_fingerprint text,
  p_daily_limit integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.ai_requests%rowtype;
  v_count integer;
begin
  if p_owner is null or p_request_id is null or p_request_id !~ '^[a-zA-Z0-9_-]{1,100}$'
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
    or p_daily_limit is null or p_daily_limit < 1 or p_daily_limit > 500 then
    raise exception using errcode='22023', message='Invalid AI reservation';
  end if;
  perform conuo_private.assert_account_access(p_owner);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text, 0));
  update public.ai_requests set state='failed', error_code='REQUEST_EXPIRED', updated_at=now()
    where owner_id=p_owner and state='running' and created_at < now() - interval '2 minutes';
  update public.ai_requests set result=null, state='failed', error_code='REQUEST_EXPIRED'
    where owner_id=p_owner and result is not null and created_at < now() - interval '24 hours';
  delete from public.ai_requests where owner_id=p_owner and created_at < now() - interval '7 days';
  select * into v_existing from public.ai_requests where owner_id=p_owner and request_id=p_request_id;
  if found then
    if v_existing.fingerprint <> p_fingerprint then return jsonb_build_object('status','mismatch'); end if;
    return jsonb_build_object('status',v_existing.state,'result',v_existing.result,'errorCode',v_existing.error_code);
  end if;
  if exists(select 1 from public.ai_requests where owner_id=p_owner and state='running') then
    return jsonb_build_object('status','busy');
  end if;
  select count(*) into v_count from public.ai_requests where owner_id=p_owner
    and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC');
  if v_count >= p_daily_limit then return jsonb_build_object('status','limited'); end if;
  insert into public.ai_requests(owner_id,request_id,fingerprint,state) values(p_owner,p_request_id,p_fingerprint,'running');
  return jsonb_build_object('status','reserved');
end;
$$;

-- A service-role table update would bypass RLS. Force final ledger writes through
-- the same account gate so a late provider response cannot recreate a deleted result.
create function public.finish_ai_request(
  p_owner uuid,
  p_request_id text,
  p_result jsonb default null,
  p_error_code text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_request_id text;
begin
  if p_owner is null or p_request_id is null or p_request_id !~ '^[a-zA-Z0-9_-]{1,100}$'
    or (p_result is not null and (jsonb_typeof(p_result) <> 'object' or octet_length(p_result::text) > 262144))
    or (p_error_code is not null and p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$') then
    raise exception using errcode='22023', message='Invalid AI request completion';
  end if;
  perform conuo_private.assert_account_access(p_owner);
  update public.ai_requests request set
    state = case when p_result is null then 'failed' else 'completed' end,
    result = p_result,
    error_code = case when p_result is null then p_error_code else null end,
    updated_at = clock_timestamp()
  where request.owner_id = p_owner and request.request_id = p_request_id and request.state = 'running'
  returning request.request_id into v_request_id;
  if v_request_id is null then
    raise exception using errcode='40001', message='AI request completion unavailable';
  end if;
  return jsonb_build_object('requestId', v_request_id);
end;
$$;

revoke all on function conuo_private.fence_account_deletion_embedding_jobs()
  from public, anon, authenticated, service_role;
revoke all on function public.finish_ai_request(uuid,text,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_ai_request(uuid,text,jsonb,text) to service_role;

commit;
