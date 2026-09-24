-- Deep thinking requests can run longer than the standard two-minute ledger lease.
begin;

alter table public.ai_requests add column expires_at timestamptz;

drop function public.reserve_ai_request(uuid, text, text, integer);

create function public.reserve_ai_request(
  p_owner uuid,
  p_request_id text,
  p_fingerprint text,
  p_daily_limit integer,
  p_ttl_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.ai_requests%rowtype;
  v_count integer;
begin
  if p_owner is null or p_request_id is null or p_request_id !~ '^[a-zA-Z0-9_-]{1,100}$'
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
    or p_daily_limit is null or p_daily_limit < 1 or p_daily_limit > 500
    or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 900 then
    raise exception using errcode='22023', message='Invalid AI reservation';
  end if;
  perform conuo_private.assert_account_access(p_owner);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text, 0));
  update public.ai_requests set state='failed', error_code='REQUEST_EXPIRED', updated_at=now()
    where owner_id=p_owner and state='running'
      and coalesce(expires_at, created_at + interval '2 minutes') < now();
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
  insert into public.ai_requests(owner_id,request_id,fingerprint,state,expires_at)
    values(p_owner,p_request_id,p_fingerprint,'running',now() + make_interval(secs => p_ttl_seconds));
  return jsonb_build_object('status','reserved');
end;
$$;

revoke all on function public.reserve_ai_request(uuid,text,text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_ai_request(uuid,text,text,integer,integer) to service_role;

commit;
