-- Membership foundation (docs/MEMBERSHIP_SYSTEM_PLAN.md, stage A).
-- Plans are configuration changed only by migrations; grants are an append-only
-- ledger changed only by the protected functions below. Nothing here changes
-- existing behavior: the legacy reservation RPC is untouched, the new RPC is
-- only used when CONUO_MEMBERSHIP_ENFORCEMENT is shadow/on, and every seeded
-- learning-space limit equals the current projection maximum (500).
-- save_workspace is copied from 20260920000200_workspace_conflict_response.sql
-- as rewritten by 20260920000300_business_conflict_response.sql ('40001' ->
-- 'PT409'); change: reject saves that add active spaces above the plan limit.
begin;

create schema if not exists conuo_private;

create function conuo_private.valid_membership_features(p_features jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_features) is distinct from 'object' then false
    else not exists (
      select 1 from jsonb_each(p_features) feature(key, value)
      where feature.key not in ('vision_region','organization','learning_ai','deep_thinking','tutor_mode')
        or jsonb_typeof(feature.value) <> 'boolean'
    )
  end;
$$;

create table public.membership_plans (
  code text primary key check (code ~ '^[a-z][a-z0-9-]{0,31}$'),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  description text not null default '' check (char_length(description) <= 1000),
  tier_rank smallint not null unique check (tier_rank between 0 and 1000),
  display_order smallint not null default 0,
  is_public boolean not null default true,
  is_grantable boolean not null default true,
  ai_daily_request_limit integer not null check (ai_daily_request_limit between 1 and 500),
  learning_space_limit integer not null check (learning_space_limit between 1 and 500),
  features jsonb not null default '{}'::jsonb
    check (conuo_private.valid_membership_features(features)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- free is the resolver fallback and always the lowest tier.
  check ((code = 'free') = (tier_rank = 0))
);

create function conuo_private.guard_membership_plan()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.code = 'free' then
      raise exception using errcode = '22023', message = 'The free plan cannot be deleted';
    end if;
    return old;
  end if;
  if old.code = 'free' and new.code <> 'free' then
    raise exception using errcode = '22023', message = 'The free plan code cannot change';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger membership_plans_guard
  before update or delete on public.membership_plans
  for each row execute function conuo_private.guard_membership_plan();

alter table public.membership_plans enable row level security;
revoke all on table public.membership_plans from public, anon, authenticated, service_role;
grant select on table public.membership_plans to authenticated;
create policy "Read public membership plans" on public.membership_plans
  for select to authenticated using (is_public);

-- Target request limits are stored now but only enforced when the server runs
-- with CONUO_MEMBERSHIP_ENFORCEMENT=on. Learning-space targets (1/5/20) are
-- applied by a later migration at stage B1.
insert into public.membership_plans
  (code, name, description, tier_rank, display_order, ai_daily_request_limit, learning_space_limit, features)
values
  ('free', '免费版', '阅读、搜索、基础 AI 体验', 0, 0, 20, 500,
    '{"vision_region":true,"organization":true,"learning_ai":true,"deep_thinking":true,"tutor_mode":true}'),
  ('pro', '专业版', '高频学习、资料整理、学习 AI', 10, 1, 100, 500,
    '{"vision_region":true,"organization":true,"learning_ai":true,"deep_thinking":true,"tutor_mode":true}'),
  ('max', '旗舰版', '重度使用和更高额度', 20, 2, 300, 500,
    '{"vision_region":true,"organization":true,"learning_ai":true,"deep_thinking":true,"tutor_mode":true}');

create table conuo_private.membership_grants (
  grant_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  plan_code text not null references public.membership_plans(code),
  source text not null check (source in ('manual','promotion','trial','system','payment')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  actor text not null check (char_length(btrim(actor)) between 1 and 200),
  note text not null check (char_length(btrim(note)) between 1 and 1000),
  external_ref text unique check (external_ref is null or external_ref ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  revoked_at timestamptz,
  revoked_by text check (revoked_by is null or char_length(btrim(revoked_by)) between 1 and 200),
  revoke_reason text check (revoke_reason is null or char_length(btrim(revoke_reason)) between 1 and 1000),
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at),
  check (source not in ('promotion','trial') or ends_at is not null),
  check (source <> 'payment' or external_ref is not null),
  check (
    (revoked_at is null and revoked_by is null and revoke_reason is null)
    or (revoked_at is not null and revoked_by is not null and revoke_reason is not null)
  )
);

create index membership_grants_owner_starts on conuo_private.membership_grants (owner_id, starts_at);
create index membership_grants_owner_unrevoked on conuo_private.membership_grants (owner_id)
  where revoked_at is null;

-- Grants are append-only: the only permitted change is recording a revocation once.
-- No delete trigger exists, so account-deletion cascades are never blocked.
create function conuo_private.guard_membership_grant()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.revoked_at is not null or new.revoked_at is null
    or (new.grant_id, new.owner_id, new.plan_code, new.source, new.starts_at, new.ends_at,
        new.actor, new.note, new.external_ref, new.created_at)
      is distinct from
       (old.grant_id, old.owner_id, old.plan_code, old.source, old.starts_at, old.ends_at,
        old.actor, old.note, old.external_ref, old.created_at) then
    raise exception using errcode = '22023', message = 'Membership grants can only be revoked';
  end if;
  return new;
end;
$$;

create trigger membership_grants_guard
  before update on conuo_private.membership_grants
  for each row execute function conuo_private.guard_membership_grant();

alter table conuo_private.membership_grants enable row level security;
revoke all on table conuo_private.membership_grants from public, anon, authenticated, service_role;

-- The single resolution point. Highest tier wins; within a tier the longest grant.
create function conuo_private.active_membership_grant(p_owner uuid, p_at timestamptz)
returns table (grant_id uuid, plan_code text, source text, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select g.grant_id, g.plan_code, g.source, g.starts_at, g.ends_at
  from conuo_private.membership_grants g
  join public.membership_plans p on p.code = g.plan_code
  where g.owner_id = p_owner
    and g.revoked_at is null
    and g.starts_at <= p_at
    and (g.ends_at is null or g.ends_at > p_at)
  order by p.tier_rank desc, g.ends_at desc nulls first, g.created_at desc
  limit 1;
$$;

create function conuo_private.effective_membership(p_owner uuid, p_at timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_grant record;
  v_has_grant boolean;
  v_plan public.membership_plans%rowtype;
  v_after text;
begin
  if p_owner is null or p_at is null then
    raise exception using errcode = '22023', message = 'Invalid membership lookup';
  end if;
  select * into v_grant from conuo_private.active_membership_grant(p_owner, p_at);
  v_has_grant := found;
  select * into v_plan from public.membership_plans plan
    where plan.code = case when v_has_grant then v_grant.plan_code else 'free' end;
  if not found then
    -- Fail closed: callers must refuse new work rather than guess a limit.
    raise exception using errcode = 'P0001', message = 'Membership plan unavailable';
  end if;
  if v_has_grant and v_grant.ends_at is not null then
    select coalesce(
      (select next_grant.plan_code from conuo_private.active_membership_grant(p_owner, v_grant.ends_at) next_grant),
      'free'
    ) into v_after;
  end if;
  return jsonb_build_object(
    'planCode', v_plan.code,
    'planName', v_plan.name,
    'tierRank', v_plan.tier_rank,
    'source', case when v_has_grant then v_grant.source end,
    'grantId', case when v_has_grant then v_grant.grant_id end,
    'startsAt', case when v_has_grant then v_grant.starts_at end,
    'endsAt', case when v_has_grant then v_grant.ends_at end,
    'afterEnd', v_after,
    'limits', jsonb_build_object(
      'aiDailyRequests', v_plan.ai_daily_request_limit,
      'learningSpaces', v_plan.learning_space_limit
    ),
    'features', v_plan.features
  );
end;
$$;

revoke all on function conuo_private.valid_membership_features(jsonb) from public, anon, authenticated, service_role;
revoke all on function conuo_private.guard_membership_plan() from public, anon, authenticated, service_role;
revoke all on function conuo_private.guard_membership_grant() from public, anon, authenticated, service_role;
revoke all on function conuo_private.active_membership_grant(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function conuo_private.effective_membership(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function public.my_membership()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  perform conuo_private.assert_account_access(v_owner);
  return conuo_private.effective_membership(v_owner, now());
end;
$$;

revoke all on function public.my_membership() from public, anon, authenticated, service_role;
grant execute on function public.my_membership() to authenticated;

create function public.resolve_membership(p_owner uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform conuo_private.assert_account_access(p_owner);
  return conuo_private.effective_membership(p_owner, now());
end;
$$;

revoke all on function public.resolve_membership(uuid) from public, anon, authenticated, service_role;
grant execute on function public.resolve_membership(uuid) to service_role;

-- Administration: executable only by the owning role (SQL Editor runs as postgres).
-- service_role is deliberately excluded so a leaked server secret cannot self-upgrade.
create function conuo_private.grant_membership(
  p_owner uuid,
  p_plan text,
  p_source text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_actor text,
  p_note text
) returns uuid language plpgsql set search_path = '' as $$
declare
  v_plan public.membership_plans%rowtype;
  v_grant_id uuid;
begin
  if p_owner is null or p_source is null or p_source not in ('manual','promotion','trial','system') then
    raise exception using errcode = '22023', message = 'Invalid membership grant source';
  end if;
  if not exists (select 1 from auth.users account where account.id = p_owner) then
    raise exception using errcode = '22023', message = 'Membership account not found';
  end if;
  perform conuo_private.assert_account_access(p_owner);
  select * into v_plan from public.membership_plans plan where plan.code = p_plan;
  if not found or not v_plan.is_grantable then
    raise exception using errcode = '22023', message = 'Membership plan is not grantable';
  end if;
  if p_ends_at is not null and p_ends_at <= now() then
    raise exception using errcode = '22023', message = 'Membership grant would already be expired';
  end if;
  insert into conuo_private.membership_grants (owner_id, plan_code, source, starts_at, ends_at, actor, note)
    values (p_owner, p_plan, p_source, coalesce(p_starts_at, now()), p_ends_at,
      btrim(coalesce(p_actor, '')), btrim(coalesce(p_note, '')))
    returning grant_id into v_grant_id;
  return v_grant_id;
exception when check_violation or not_null_violation then
  raise exception using errcode = '22023', message = 'Invalid membership grant';
end;
$$;

create function conuo_private.revoke_membership_grant(p_grant_id uuid, p_actor text, p_reason text)
returns uuid language plpgsql set search_path = '' as $$
declare v_grant_id uuid;
begin
  update conuo_private.membership_grants grant_row set
    revoked_at = now(),
    revoked_by = btrim(coalesce(p_actor, '')),
    revoke_reason = btrim(coalesce(p_reason, ''))
  where grant_row.grant_id = p_grant_id and grant_row.revoked_at is null
  returning grant_row.grant_id into v_grant_id;
  if v_grant_id is null then
    raise exception using errcode = '22023', message = 'Membership grant not found or already revoked';
  end if;
  return v_grant_id;
exception when check_violation then
  raise exception using errcode = '22023', message = 'Invalid membership revocation';
end;
$$;

-- "Downgrade to free": revoke every current or future non-payment grant.
create function conuo_private.revoke_active_memberships(p_owner uuid, p_actor text, p_reason text)
returns integer language plpgsql set search_path = '' as $$
declare v_count integer;
begin
  if p_owner is null then
    raise exception using errcode = '22023', message = 'Invalid membership account';
  end if;
  update conuo_private.membership_grants grant_row set
    revoked_at = now(),
    revoked_by = btrim(coalesce(p_actor, '')),
    revoke_reason = btrim(coalesce(p_reason, ''))
  where grant_row.owner_id = p_owner
    and grant_row.revoked_at is null
    and grant_row.source <> 'payment'
    and (grant_row.ends_at is null or grant_row.ends_at > now());
  get diagnostics v_count = row_count;
  return v_count;
exception when check_violation then
  raise exception using errcode = '22023', message = 'Invalid membership revocation';
end;
$$;

revoke all on function conuo_private.grant_membership(uuid,text,text,timestamptz,timestamptz,text,text)
  from public, anon, authenticated, service_role;
revoke all on function conuo_private.revoke_membership_grant(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function conuo_private.revoke_active_memberships(uuid,text,text)
  from public, anon, authenticated, service_role;

-- Route is recorded for analysis and future per-route limits; legacy rows stay null.
alter table public.ai_requests add column route text
  check (route is null or route in ('ask','organize','organization-job','vision','learning','glossary'));

-- Every requested feature must be enabled; a missing key is disabled.
create function conuo_private.membership_features_allowed(p_membership jsonb, p_features text[])
returns boolean language sql immutable set search_path = '' as $$
  select not exists (
    select 1 from unnest(coalesce(p_features, '{}'::text[])) feature(name)
    where coalesce((p_membership->'features'->>feature.name)::boolean, false) is not true
  );
$$;

revoke all on function conuo_private.membership_features_allowed(jsonb, text[])
  from public, anon, authenticated, service_role;

-- Copied from 20260926000200_ai_token_usage.sql reserve_ai_request.
-- Changes: resolve the request limit and feature switch from membership in the
-- same owner lock, record the route, and support off/shadow/on enforcement.
create function public.reserve_membership_ai_request(
  p_owner uuid,
  p_request_id text,
  p_fingerprint text,
  p_route text,
  p_features text[],
  p_global_cap integer,
  p_enforcement text,
  p_ttl_seconds integer default 120,
  p_daily_token_limit integer default 0
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.ai_requests%rowtype;
  v_count integer;
  v_limit integer;
  v_membership jsonb;
  v_plan_limit integer;
  v_feature_allowed boolean := true;
  v_shadow jsonb;
  v_token_usage jsonb;
begin
  if p_owner is null or p_request_id is null or p_request_id !~ '^[a-zA-Z0-9_-]{1,100}$'
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
    or p_route is null or p_route not in ('ask','organize','organization-job','vision','learning','glossary')
    or (p_features is not null and (cardinality(p_features) > 5 or exists (
      select 1 from unnest(p_features) feature(name)
      where feature.name is null
        or feature.name not in ('vision_region','organization','learning_ai','deep_thinking','tutor_mode')
    )))
    or p_global_cap is null or p_global_cap < 1 or p_global_cap > 500
    or p_enforcement is null or p_enforcement not in ('off','shadow','on')
    or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 900
    or p_daily_token_limit is null or p_daily_token_limit < 0 or p_daily_token_limit > 100000000 then
    raise exception using errcode='22023', message='Invalid AI reservation';
  end if;
  perform conuo_private.assert_account_access(p_owner);
  -- Same key as reserve_ai_request so both signatures serialize one owner together.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text, 0));
  update public.ai_requests set state='failed', error_code='REQUEST_EXPIRED', updated_at=now()
    where owner_id=p_owner and state='running'
      and coalesce(expires_at, created_at + interval '2 minutes') < now();
  update public.ai_requests set result=null, state='failed', error_code='REQUEST_EXPIRED'
    where owner_id=p_owner and result is not null and created_at < now() - interval '24 hours';
  delete from public.ai_requests where owner_id=p_owner and created_at < now() - interval '7 days';
  -- Replays of an existing request are never re-checked against membership.
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

  v_limit := p_global_cap;
  if p_enforcement = 'on' then
    v_membership := conuo_private.effective_membership(p_owner, now());
    v_feature_allowed := conuo_private.membership_features_allowed(v_membership, p_features);
    if not v_feature_allowed then
      return jsonb_build_object('status','feature_unavailable','planCode',v_membership->>'planCode');
    end if;
    v_limit := least((v_membership->'limits'->>'aiDailyRequests')::integer, p_global_cap);
  elsif p_enforcement = 'shadow' then
    -- Shadow mode observes only: a resolution failure must not change the outcome.
    begin
      v_membership := conuo_private.effective_membership(p_owner, now());
      v_plan_limit := least((v_membership->'limits'->>'aiDailyRequests')::integer, p_global_cap);
      v_feature_allowed := conuo_private.membership_features_allowed(v_membership, p_features);
      v_shadow := jsonb_build_object(
        'planCode', v_membership->>'planCode',
        'planLimit', v_plan_limit,
        'wouldLimit', v_count >= v_plan_limit,
        'featureAllowed', v_feature_allowed
      );
    exception when others then
      v_shadow := jsonb_build_object('error', 'MEMBERSHIP_UNAVAILABLE');
    end;
  end if;

  if v_count >= v_limit then
    return jsonb_build_object('status','limited') || case when v_shadow is null then '{}'::jsonb else jsonb_build_object('shadow',v_shadow) end;
  end if;
  if p_daily_token_limit > 0 then
    v_token_usage := public.ai_token_usage_today(p_owner);
    if coalesce((v_token_usage->>'promptTokens')::numeric, 0)
      + coalesce((v_token_usage->>'completionTokens')::numeric, 0) >= p_daily_token_limit then
      return jsonb_build_object('status','token_limited') || case when v_shadow is null then '{}'::jsonb else jsonb_build_object('shadow',v_shadow) end;
    end if;
  end if;
  insert into public.ai_requests(owner_id,request_id,fingerprint,state,expires_at,route)
    values(p_owner,p_request_id,p_fingerprint,'running',now() + make_interval(secs => p_ttl_seconds),p_route);
  return jsonb_build_object('status','reserved') || case when v_shadow is null then '{}'::jsonb else jsonb_build_object('shadow',v_shadow) end;
end;
$$;

revoke all on function public.reserve_membership_ai_request(uuid,text,text,text,text[],integer,text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_membership_ai_request(uuid,text,text,text,text[],integer,text,integer,integer)
  to service_role;

-- Usage uses the same limit rule as the reservation above.
create function public.ai_membership_usage(p_owner uuid, p_global_cap integer, p_enforcement text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_membership jsonb;
  v_limit integer := p_global_cap;
begin
  if p_owner is null or p_global_cap is null or p_global_cap < 1 or p_global_cap > 500
    or p_enforcement is null or p_enforcement not in ('off','shadow','on') then
    raise exception using errcode='22023', message='Invalid AI usage lookup';
  end if;
  perform conuo_private.assert_account_access(p_owner);
  select count(*) into v_count from public.ai_requests where owner_id=p_owner
    and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC');
  if p_enforcement <> 'off' then
    v_membership := conuo_private.effective_membership(p_owner, now());
    if p_enforcement = 'on' then
      v_limit := least((v_membership->'limits'->>'aiDailyRequests')::integer, p_global_cap);
    end if;
  end if;
  return jsonb_build_object('usedCount', v_count, 'dailyLimit', v_limit, 'membership', v_membership);
end;
$$;

revoke all on function public.ai_membership_usage(uuid,integer,text) from public, anon, authenticated, service_role;
grant execute on function public.ai_membership_usage(uuid,integer,text) to service_role;

create function conuo_private.active_learning_space_count(p_data jsonb)
returns integer language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_data->'spaces') = 'array' then (
      select count(*)::integer from jsonb_array_elements(p_data->'spaces') space(value)
      where (space.value->'archived') is distinct from 'true'::jsonb
    )
    else 0
  end;
$$;

revoke all on function conuo_private.active_learning_space_count(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.save_workspace(p_data jsonb, p_expected_revision bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_revision bigint;
  v_project_workspace boolean := true;
  v_old_active integer;
  v_new_active integer;
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

  -- Account deletion uses the same owner lock. Recheck after serialization so a
  -- deletion committed between the first access check and this lock cannot race a save.
  perform conuo_private.assert_account_access(v_owner);

  perform conuo_private.validate_workspace_payload(v_owner, p_data);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_owner for update;

  if p_expected_revision = 0 then
    if found then
      raise exception using errcode = 'PT409', message = 'Workspace revision conflict';
    end if;
    insert into public.workspaces(owner_id, data, revision)
      values (v_owner, p_data, 1)
      returning revision into v_revision;
  else
    if not found or v_workspace.revision <> p_expected_revision then
      raise exception using errcode = 'PT409', message = 'Workspace revision conflict';
    end if;
    perform conuo_private.assert_import_parse_leases_unchanged(
      v_owner, v_workspace.data, p_data
    );
    v_project_workspace :=
      conuo_private.workspace_retrieval_projection_input(v_workspace.data)
      is distinct from
      conuo_private.workspace_retrieval_projection_input(p_data);
    update public.workspaces workspace
      set data = p_data, revision = workspace.revision + 1, updated_at = now()
      where workspace.owner_id = v_owner and workspace.revision = p_expected_revision
      returning workspace.revision into v_revision;
  end if;

  if v_revision is null then
    raise exception using errcode = 'PT409', message = 'Workspace revision conflict';
  end if;

  -- Membership space limit: only a save that adds active spaces beyond the plan
  -- limit is refused, so downgraded accounts can always keep saving existing work.
  -- Ordinary saves never resolve membership.
  v_old_active := case when p_expected_revision = 0 then 0
    else conuo_private.active_learning_space_count(v_workspace.data) end;
  v_new_active := conuo_private.active_learning_space_count(p_data);
  if v_new_active > v_old_active
    and v_new_active > (conuo_private.effective_membership(v_owner, now())->'limits'->>'learningSpaces')::integer then
    raise exception using errcode = 'PT403', message = 'Learning space limit reached';
  end if;

  if v_project_workspace then
    perform conuo_private.project_workspace(v_owner, p_data);
  end if;
  return v_revision;
exception when serialization_failure then
  -- Business revision/dependency fences must return promptly through PostgREST.
  -- Preserve rollback of the entire save, including all read projections.
  raise exception using errcode = 'PT409', message = 'Workspace revision conflict';
end;
$$;

revoke all on function public.save_workspace(jsonb,bigint) from public, anon, service_role;
grant execute on function public.save_workspace(jsonb,bigint) to authenticated;

commit;
