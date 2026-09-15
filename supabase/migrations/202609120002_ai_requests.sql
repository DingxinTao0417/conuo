-- Server-only request reservations. Never grant the browser access to this table/RPC.
begin;

create table public.ai_requests (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (request_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('running', 'completed', 'failed')),
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, request_id),
  check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 262144))
);
create index ai_requests_owner_created on public.ai_requests(owner_id, created_at);
alter table public.ai_requests enable row level security;
revoke all on table public.ai_requests from public, anon, authenticated;
grant select, insert, update, delete on public.ai_requests to service_role;

create function public.reserve_ai_request(p_owner uuid, p_request_id text, p_fingerprint text, p_daily_limit integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_existing public.ai_requests%rowtype;
  v_count integer;
begin
  if p_owner is null or p_request_id is null or p_request_id !~ '^[a-zA-Z0-9_-]{1,100}$'
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
    or p_daily_limit is null or p_daily_limit < 1 or p_daily_limit > 500 then
    raise exception using errcode='22023', message='Invalid AI reservation';
  end if;
  -- Serialize an owner's reservations, including concurrent Vercel instances.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text, 0));
  -- A timed-out execution is never silently rerun under the same request ID.
  update public.ai_requests set state='failed', error_code='REQUEST_EXPIRED', updated_at=now()
    where owner_id=p_owner and state='running' and created_at < now() - interval '2 minutes';
  -- Lazy retention: result content expires after 24h; metadata after seven days.
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

revoke all on function public.reserve_ai_request(uuid,text,text,integer) from public, anon, authenticated;
grant execute on function public.reserve_ai_request(uuid,text,text,integer) to service_role;
commit;
