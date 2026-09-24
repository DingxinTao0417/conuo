begin;

create table public.source_version_summaries (
  owner_id uuid not null,
  source_id text not null,
  version_id text not null,
  profile text not null check (profile = 'summary-v1'),
  level text not null check (level in ('section','document')),
  section_index integer not null check (section_index between 0 and 1000),
  title text not null check (char_length(title) between 1 and 200),
  page_start integer check (page_start is null or page_start between 1 and 100000),
  page_end integer check (page_end is null or page_end between 1 and 100000),
  chunk_ids text[] not null check (cardinality(chunk_ids) between 1 and 400),
  summary jsonb not null check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 32768),
  model_name text check (model_name is null or char_length(model_name) <= 200),
  created_at timestamptz not null default now(),
  primary key (owner_id, source_id, version_id, profile, level, section_index),
  foreign key (owner_id, source_id, version_id) references public.source_versions on delete cascade
);

create table conuo_private.summary_jobs (
  job_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_id text not null,
  version_id text not null,
  profile text not null default 'summary-v1' check (profile = 'summary-v1'),
  state text not null check (state in ('queued','running','succeeded','failed','cancelled')),
  sections_total integer check (sections_total is null or sections_total between 1 and 60),
  sections_done integer not null default 0 check (sections_done between 0 and 60),
  attempt integer not null default 0 check (attempt between 0 and 5),
  worker_id text,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, source_id, version_id, profile),
  foreign key (owner_id, source_id, version_id) references public.source_versions on delete cascade
);

create table conuo_private.summary_usage (
  owner_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  sections integer not null default 0 check (sections >= 0),
  primary key (owner_id, usage_date)
);

alter table public.source_version_summaries enable row level security;
alter table conuo_private.summary_jobs enable row level security;
alter table conuo_private.summary_usage enable row level security;
revoke all on table public.source_version_summaries from public, anon, authenticated, service_role;
revoke all on table conuo_private.summary_jobs from public, anon, authenticated, service_role;
revoke all on table conuo_private.summary_usage from public, anon, authenticated, service_role;

create function conuo_private.summary_eligible(p_owner uuid, p_source text, p_version text)
returns boolean language sql stable set search_path = '' as $$
  select not conuo_private.account_deletion_blocked(p_owner) and exists (
    select 1 from public.sources s
    join public.source_versions v on v.owner_id=s.owner_id and v.source_id=s.source_id
      and v.version_id=s.current_version_id
    join public.workspaces w on w.owner_id=s.owner_id
    where s.owner_id=p_owner and s.source_id=p_source and s.current_version_id=p_version
      and s.retained and s.deleted_at is null and s.ai_allowed
      and v.retained and v.status in ('ready','partial')
      and w.data->>'aiEnabled'='true'
      and exists (select 1 from public.source_chunks c where c.owner_id=p_owner
        and c.source_id=p_source and c.version_id=p_version)
  );
$$;

create function conuo_private.lock_summary_job(p_job_id uuid, p_lease_token uuid default null)
returns conuo_private.summary_jobs language plpgsql set search_path = '' as $$
declare j conuo_private.summary_jobs; v_owner uuid;
begin
  select owner_id into v_owner from conuo_private.summary_jobs where job_id=p_job_id;
  if v_owner is null then raise exception using errcode='PT409', message='Summary lease unavailable'; end if;
  perform conuo_private.owner_lock(v_owner);
  select * into j from conuo_private.summary_jobs where job_id=p_job_id for update;
  if p_lease_token is null or j.lease_token is distinct from p_lease_token
    or j.state <> 'running' or j.lease_until is null or j.lease_until <= clock_timestamp()
    or not conuo_private.summary_eligible(j.owner_id,j.source_id,j.version_id) then
    raise exception using errcode='PT409', message='Summary lease unavailable';
  end if;
  return j;
end;
$$;

create function public.request_source_summary(p_source_id text, p_version_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); j conuo_private.summary_jobs;
begin
  if v_owner is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id)
    then raise exception using errcode='22023', message='Invalid source summary request'; end if;
  perform conuo_private.assert_account_access(v_owner);
  if not conuo_private.summary_eligible(v_owner,p_source_id,p_version_id) then
    raise exception using errcode='PT409', message='Summary source unavailable';
  end if;
  perform conuo_private.owner_lock(v_owner);
  select * into j from conuo_private.summary_jobs where owner_id=v_owner
    and source_id=p_source_id and version_id=p_version_id and profile='summary-v1' for update;
  if not found then
    insert into conuo_private.summary_jobs(owner_id,source_id,version_id,profile,state)
      values(v_owner,p_source_id,p_version_id,'summary-v1','queued') returning * into j;
  end if;
  return jsonb_build_object('jobId',j.job_id,'sourceId',j.source_id,'versionId',j.version_id,
    'state',j.state,'sectionsTotal',j.sections_total,'sectionsDone',j.sections_done,
    'errorCode',j.error_code,'updatedAt',j.updated_at);
end;
$$;

create function public.source_summary_status(p_source_id text, p_version_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); j conuo_private.summary_jobs; rows jsonb;
begin
  if v_owner is null then raise exception using errcode='42501', message='Authentication required'; end if;
  perform conuo_private.assert_account_access(v_owner);
  select * into j from conuo_private.summary_jobs where owner_id=v_owner and source_id=p_source_id
    and version_id=p_version_id and profile='summary-v1';
  select coalesce(jsonb_agg(jsonb_build_object('level',s.level,'sectionIndex',s.section_index,
    'title',s.title,'pageStart',s.page_start,'pageEnd',s.page_end,'summary',s.summary,
    'chunkIds',s.chunk_ids,'modelName',s.model_name,'createdAt',s.created_at)
    order by s.level='document',s.section_index),'[]'::jsonb) into rows
    from public.source_version_summaries s where s.owner_id=v_owner and s.source_id=p_source_id
      and s.version_id=p_version_id and s.profile='summary-v1';
  return jsonb_build_object('sourceId',p_source_id,'versionId',p_version_id,
    'state',coalesce(j.state,'not_requested'),'jobId',j.job_id,'sectionsTotal',j.sections_total,
    'sectionsDone',j.sections_done,'errorCode',j.error_code,'summaries',rows);
end;
$$;

create function public.read_source_summaries(p_source_id text, p_version_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); rows jsonb;
begin
  if v_owner is null then raise exception using errcode='42501', message='Authentication required'; end if;
  perform conuo_private.assert_account_access(v_owner);
  if not exists (select 1 from public.sources s where s.owner_id=v_owner and s.source_id=p_source_id
    and s.current_version_id=p_version_id and s.retained and s.deleted_at is null) then
    raise exception using errcode='PT409', message='Summary source unavailable';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('level',s.level,'sectionIndex',s.section_index,
    'title',s.title,'pageStart',s.page_start,'pageEnd',s.page_end,'summary',s.summary,
    'chunkIds',s.chunk_ids,'modelName',s.model_name,'createdAt',s.created_at)
    order by s.level='document',s.section_index),'[]'::jsonb) into rows
    from public.source_version_summaries s where s.owner_id=v_owner and s.source_id=p_source_id
      and s.version_id=p_version_id and s.profile='summary-v1';
  return rows;
end;
$$;

create function public.claim_summary_jobs(p_worker_id text, p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j conuo_private.summary_jobs; candidate record; result jsonb := '[]'::jsonb;
begin
  if not conuo_private.valid_id(p_worker_id) or p_lease_seconds not between 15 and 300 then
    raise exception using errcode='22023', message='Invalid summary claim';
  end if;
  for candidate in select job_id,owner_id from conuo_private.summary_jobs
    where (state='queued' and next_attempt_at<=clock_timestamp())
       or (state='running' and lease_until<=clock_timestamp())
    order by next_attempt_at,created_at,job_id limit 20 loop
    if not pg_try_advisory_xact_lock(hashtextextended('conuo:source:' || candidate.owner_id::text,0)) then continue; end if;
    select * into j from conuo_private.summary_jobs where job_id=candidate.job_id for update skip locked;
    if not found then continue; end if;
    if not conuo_private.summary_eligible(j.owner_id,j.source_id,j.version_id) then
      update conuo_private.summary_jobs set state='cancelled',error_code='SOURCE_INELIGIBLE',
        lease_token=null,lease_until=null,updated_at=now() where job_id=j.job_id;
      continue;
    end if;
    if j.attempt>=5 then
      update conuo_private.summary_jobs set state='failed',error_code='ATTEMPTS_EXHAUSTED',
        lease_token=null,lease_until=null,updated_at=now() where job_id=j.job_id;
      continue;
    end if;
    update conuo_private.summary_jobs set state='running',attempt=attempt+1,worker_id=p_worker_id,
      lease_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      error_code=null,updated_at=now() where job_id=j.job_id returning * into j;
    result := jsonb_build_object('jobs',jsonb_build_array(jsonb_build_object('jobId',j.job_id,
      'ownerId',j.owner_id,'sourceId',j.source_id,'versionId',j.version_id,'profile',j.profile,
      'leaseToken',j.lease_token,'leaseUntil',j.lease_until,'sectionsDone',j.sections_done,
      'sectionsTotal',j.sections_total,'attempt',j.attempt)));
    return result;
  end loop;
  return jsonb_build_object('jobs',result);
end;
$$;

create function public.read_summary_job_context(p_job_id uuid, p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j conuo_private.summary_jobs; chunks jsonb; outlines jsonb; summaries jsonb;
begin
  j := conuo_private.lock_summary_job(p_job_id,p_lease_token);
  select coalesce(jsonb_agg(jsonb_build_object('id',c.chunk_id,'text',c.text,'page',c.page,
    'ordinal',c.ordinal,'section',c.section) order by c.position),'[]'::jsonb) into chunks
    from public.source_chunks c where c.owner_id=j.owner_id and c.source_id=j.source_id and c.version_id=j.version_id;
  select coalesce((select jsonb_build_object('items',o.items,'updatedAt',o.updated_at)
    from public.source_outlines o where o.owner_id=j.owner_id and o.source_id=j.source_id and o.version_id=j.version_id),'null'::jsonb) into outlines;
  select coalesce(jsonb_agg(jsonb_build_object('level',s.level,'sectionIndex',s.section_index,'title',s.title,
    'pageStart',s.page_start,'pageEnd',s.page_end,'summary',s.summary,'chunkIds',s.chunk_ids,'modelName',s.model_name)
    order by s.level='document',s.section_index),'[]'::jsonb) into summaries
    from public.source_version_summaries s where s.owner_id=j.owner_id and s.source_id=j.source_id and s.version_id=j.version_id;
  return jsonb_build_object('jobId',j.job_id,'ownerId',j.owner_id,'sourceId',j.source_id,'versionId',j.version_id,
    'leaseToken',j.lease_token,'leaseUntil',j.lease_until,'sectionsDone',j.sections_done,
    'sectionsTotal',j.sections_total,'chunks',chunks,'outline',outlines,'summaries',summaries);
end;
$$;

create function public.reserve_summary_section(p_owner uuid, p_daily_limit integer default 60)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d date := (clock_timestamp() at time zone 'UTC')::date; used integer;
begin
  if p_owner is null or p_daily_limit not between 1 and 500 then
    raise exception using errcode='22023', message='Invalid summary usage reservation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('conuo:summary-usage:' || p_owner::text,0));
  select sections into used from conuo_private.summary_usage where owner_id=p_owner and usage_date=d for update;
  if coalesce(used,0)+1>p_daily_limit then return jsonb_build_object('allowed',false,'used',coalesce(used,0)); end if;
  insert into conuo_private.summary_usage(owner_id,usage_date,sections) values(p_owner,d,1)
    on conflict (owner_id,usage_date) do update set sections=conuo_private.summary_usage.sections+1;
  return jsonb_build_object('allowed',true,'used',coalesce(used,0)+1);
end;
$$;

create function public.stage_summary_section(p_job_id uuid, p_lease_token uuid, p_section jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j conuo_private.summary_jobs; v_index integer; v_summary jsonb; v_ids text[]; v_title text; existed boolean;
begin
  j := conuo_private.lock_summary_job(p_job_id,p_lease_token);
  if jsonb_typeof(p_section) is distinct from 'object' or not (p_section ? 'index')
    or not (p_section ? 'title') or not (p_section ? 'summary') or not (p_section ? 'chunkIds') then
    raise exception using errcode='22023', message='Invalid summary section';
  end if;
  v_index := (p_section->>'index')::integer; v_title := p_section->>'title'; v_summary := p_section->'summary';
  select array_agg(value #>> '{}') into v_ids from jsonb_array_elements(p_section->'chunkIds');
  if v_index not between 0 and 1000 or char_length(v_title) not between 1 and 200
    or cardinality(v_ids) not between 1 and 400 or jsonb_typeof(v_summary)<>'object'
    or not exists (select 1 from public.source_chunks c where c.owner_id=j.owner_id and c.source_id=j.source_id
      and c.version_id=j.version_id and c.chunk_id=any(v_ids)) then
    raise exception using errcode='22023', message='Invalid summary section';
  end if;
  if jsonb_typeof(v_summary->'paragraphs') is distinct from 'array'
     or jsonb_array_length(v_summary->'paragraphs') not between 2 and 8
     or exists (select 1 from jsonb_array_elements(v_summary->'paragraphs') p
       where jsonb_typeof(p) is distinct from 'object'
         or jsonb_typeof(p->'text') is distinct from 'string'
         or char_length(p->>'text') not between 1 and 600
         or jsonb_typeof(p->'chunkIds') is distinct from 'array'
         or jsonb_array_length(p->'chunkIds') not between 1 and 6
         or exists (select 1 from jsonb_array_elements_text(p->'chunkIds') id where not (id = any(v_ids)))) then
    raise exception using errcode='22023', message='Invalid summary evidence';
  end if;
  select exists(select 1 from public.source_version_summaries where owner_id=j.owner_id and source_id=j.source_id
    and version_id=j.version_id and profile='summary-v1' and level='section' and section_index=v_index) into existed;
  insert into public.source_version_summaries(owner_id,source_id,version_id,profile,level,section_index,title,
    page_start,page_end,chunk_ids,summary,model_name)
    values(j.owner_id,j.source_id,j.version_id,'summary-v1','section',v_index,v_title,
      nullif((p_section->>'pageStart')::integer,0),nullif((p_section->>'pageEnd')::integer,0),v_ids,v_summary,p_section->>'modelName')
    on conflict (owner_id,source_id,version_id,profile,level,section_index) do update set
      title=excluded.title,page_start=excluded.page_start,page_end=excluded.page_end,chunk_ids=excluded.chunk_ids,
      summary=excluded.summary,model_name=excluded.model_name,created_at=now();
  if p_section ? 'sectionsTotal' then
    if (p_section->>'sectionsTotal')::integer not between 1 and 60 then
      raise exception using errcode='22023', message='Invalid summary section count';
    end if;
    update conuo_private.summary_jobs set sections_total=(p_section->>'sectionsTotal')::integer,updated_at=now()
      where job_id=j.job_id and sections_total is null;
  end if;
  if not existed then update conuo_private.summary_jobs set sections_done=sections_done+1,updated_at=now()
    where job_id=j.job_id; end if;
  return jsonb_build_object('staged',true,'sectionsDone',j.sections_done + case when existed then 0 else 1 end);
end;
$$;

create function public.finish_summary_job(p_job_id uuid, p_lease_token uuid, p_document jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j conuo_private.summary_jobs;
begin
  j := conuo_private.lock_summary_job(p_job_id,p_lease_token);
  if j.sections_total is null or j.sections_done < j.sections_total or jsonb_typeof(p_document) is distinct from 'object' then
    raise exception using errcode='PT409', message='Summary job incomplete';
  end if;
  insert into public.source_version_summaries(owner_id,source_id,version_id,profile,level,section_index,title,
    chunk_ids,summary,model_name) values(j.owner_id,j.source_id,j.version_id,'summary-v1','document',0,
    coalesce(nullif(p_document->>'title',''),'全书摘要'),
    (select array_agg(distinct value #>> '{}') from jsonb_array_elements(coalesce(p_document->'chunkIds','[]'::jsonb))),
    p_document->'summary',p_document->>'modelName')
    on conflict (owner_id,source_id,version_id,profile,level,section_index) do update set
      title=excluded.title,chunk_ids=excluded.chunk_ids,summary=excluded.summary,model_name=excluded.model_name,created_at=now();
  update conuo_private.summary_jobs set state='succeeded',lease_token=null,lease_until=null,error_code=null,updated_at=now()
    where job_id=j.job_id;
  return jsonb_build_object('state','succeeded');
end;
$$;

create function public.heartbeat_summary_job(p_job_id uuid, p_lease_token uuid, p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j conuo_private.summary_jobs;
begin
  if p_lease_seconds not between 15 and 300 then raise exception using errcode='22023', message='Invalid summary lease duration'; end if;
  j := conuo_private.lock_summary_job(p_job_id,p_lease_token);
  update conuo_private.summary_jobs set lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=now()
    where job_id=j.job_id returning * into j;
  return jsonb_build_object('leaseUntil',j.lease_until);
end;
$$;

create function public.fail_summary_job(p_job_id uuid, p_lease_token uuid, p_error_code text, p_retryable boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j conuo_private.summary_jobs;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' or p_retryable is null then
    raise exception using errcode='22023', message='Invalid summary failure'; end if;
  j := conuo_private.lock_summary_job(p_job_id,p_lease_token);
  update conuo_private.summary_jobs set state=case when p_retryable and attempt<5 then 'queued' else 'failed' end,
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(900,15*(2^(attempt-1))::integer)),error_code=p_error_code,
    lease_token=null,lease_until=null,updated_at=now() where job_id=j.job_id returning * into j;
  return jsonb_build_object('state',j.state,'nextAttemptAt',j.next_attempt_at);
end;
$$;

revoke all on function conuo_private.summary_eligible(uuid,text,text), conuo_private.lock_summary_job(uuid,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.request_source_summary(text,text), public.source_summary_status(text,text),
  public.read_source_summaries(text,text) from public,anon,service_role;
grant execute on function public.request_source_summary(text,text), public.source_summary_status(text,text),
  public.read_source_summaries(text,text) to authenticated;
revoke all on function public.claim_summary_jobs(text,integer), public.read_summary_job_context(uuid,uuid),
  public.reserve_summary_section(uuid,integer), public.stage_summary_section(uuid,uuid,jsonb),
  public.finish_summary_job(uuid,uuid,jsonb), public.heartbeat_summary_job(uuid,uuid,integer),
  public.fail_summary_job(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_summary_jobs(text,integer), public.read_summary_job_context(uuid,uuid),
  public.reserve_summary_section(uuid,integer), public.stage_summary_section(uuid,uuid,jsonb),
  public.finish_summary_job(uuid,uuid,jsonb), public.heartbeat_summary_job(uuid,uuid,integer),
  public.fail_summary_job(uuid,uuid,text,boolean) to service_role;

commit;
