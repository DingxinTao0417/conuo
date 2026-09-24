begin;

create table conuo_private.ai_request_traces (
  trace_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id text check (request_id is null or request_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  route text not null check (route in ('ask','organize','organization-job','vision','embedding','summary','learning','eval')),
  contract_version text check (contract_version is null or contract_version ~ '^[a-z0-9.-]{1,40}$'),
  model_profile text check (model_profile is null or model_profile in ('default','fast','reasoning','vision','embedding','rerank')),
  model_name text check (model_name is null or char_length(model_name) <= 200),
  outcome text not null check (outcome in ('completed','insufficient','failed','cancelled','cached','extractive')),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object' and octet_length(metrics::text) <= 16384),
  created_at timestamptz not null default now()
);

create index ai_request_traces_owner_created on conuo_private.ai_request_traces(owner_id,created_at);
create index ai_request_traces_created on conuo_private.ai_request_traces(created_at);
alter table conuo_private.ai_request_traces enable row level security;
revoke all on table conuo_private.ai_request_traces from public,anon,authenticated,service_role;

create function public.record_ai_trace(p_owner uuid,p_trace jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_owner is null or jsonb_typeof(p_trace) is distinct from 'object'
     or octet_length(p_trace::text)>20000 then
    raise exception 'invalid AI trace' using errcode='22023';
  end if;
  delete from conuo_private.ai_request_traces
    where owner_id=p_owner and created_at < now()-interval '30 days';
  insert into conuo_private.ai_request_traces(
    owner_id,request_id,route,contract_version,model_profile,model_name,outcome,error_code,metrics
  ) values (
    p_owner,p_trace->>'requestId',p_trace->>'route',p_trace->>'contractVersion',p_trace->>'modelProfile',
    p_trace->>'modelName',p_trace->>'outcome',p_trace->>'errorCode',coalesce(p_trace->'metrics','{}'::jsonb)
  );
exception when check_violation or invalid_text_representation or not_null_violation then
  raise exception 'invalid AI trace' using errcode='22023';
end; $$;

revoke all on function public.record_ai_trace(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_ai_trace(uuid,jsonb) to service_role;

commit;
