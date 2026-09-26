-- AI token ledger (docs/MEMBERSHIP_SYSTEM_PLAN.md §8.5).
-- Copied from 202609120007_account_deletion_embedding_fence.sql and
-- 20260926000200_ai_token_usage.sql. Changes: request rows now retain prompt
-- and completion totals, finish_ai_request can add usage for several model
-- calls under one request ID, and model calls without an AI request lease
-- (OCR and summary workers) use a private token-only ledger. Token totals no
-- longer depend on the optional ai_request_traces table.
begin;

alter table public.ai_requests
  add column prompt_tokens bigint not null default 0
    check (prompt_tokens between 0 and 9007199254740991),
  add column completion_tokens bigint not null default 0
    check (completion_tokens between 0 and 9007199254740991);

create table conuo_private.ai_token_usage_ledger (
  usage_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (request_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  route text not null check (route in (
    'ask','organize','organization-job','vision','learning','glossary',
    'ocr','summary'
  )),
  prompt_tokens bigint not null check (prompt_tokens between 0 and 9007199254740991),
  completion_tokens bigint not null check (completion_tokens between 0 and 9007199254740991),
  created_at timestamptz not null default now()
);
create index ai_token_usage_ledger_owner_created
  on conuo_private.ai_token_usage_ledger(owner_id, created_at);
alter table conuo_private.ai_token_usage_ledger enable row level security;
revoke all on table conuo_private.ai_token_usage_ledger
  from public, anon, authenticated, service_role;

-- Token-only model calls do not create an ai_requests row, so OCR and summary
-- remain outside the daily AI request-count quota while still entering the
-- same token total used by reserve_ai_request.
create function public.record_ai_token_usage(
  p_owner uuid,
  p_request_id text,
  p_route text,
  p_prompt_tokens bigint,
  p_completion_tokens bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_owner is null
    or p_request_id is null
    or p_request_id !~ '^[a-zA-Z0-9_-]{1,100}$'
    or p_route is null
    or p_route not in ('ask','organize','organization-job','vision','learning','glossary','ocr','summary')
    or p_prompt_tokens is null
    or p_prompt_tokens < 0
    or p_prompt_tokens > 9007199254740991
    or p_completion_tokens is null
    or p_completion_tokens < 0
    or p_completion_tokens > 9007199254740991 then
    raise exception using errcode = '22023', message = 'Invalid AI token usage';
  end if;
  perform conuo_private.assert_account_access(p_owner);
  delete from conuo_private.ai_token_usage_ledger
    where owner_id = p_owner and created_at < now() - interval '30 days';
  insert into conuo_private.ai_token_usage_ledger(
    owner_id, request_id, route, prompt_tokens, completion_tokens
  ) values (
    p_owner, p_request_id, p_route, p_prompt_tokens, p_completion_tokens
  );
  return jsonb_build_object('recorded', true);
end;
$$;

revoke all on function public.record_ai_token_usage(uuid,text,text,bigint,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.record_ai_token_usage(uuid,text,text,bigint,bigint)
  to service_role;

-- Count request-row totals plus token-only model calls in the same UTC window.
create or replace function public.ai_token_usage_today(p_owner uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with utc_window as (
    select
      date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' as start_at,
      (date_trunc('day', now() at time zone 'UTC') + interval '1 day') at time zone 'UTC' as reset_at
  ),
  request_totals as (
    select
      coalesce(sum(prompt_tokens), 0)::numeric as prompt_tokens,
      coalesce(sum(completion_tokens), 0)::numeric as completion_tokens
    from public.ai_requests request
    cross join utc_window
    where request.owner_id = p_owner
      and request.created_at >= utc_window.start_at
      and request.created_at < utc_window.reset_at
  ),
  token_only_totals as (
    select
      coalesce(sum(usage.prompt_tokens), 0)::numeric as prompt_tokens,
      coalesce(sum(usage.completion_tokens), 0)::numeric as completion_tokens
    from conuo_private.ai_token_usage_ledger usage
    cross join utc_window
    where usage.owner_id = p_owner
      and usage.created_at >= utc_window.start_at
      and usage.created_at < utc_window.reset_at
  )
  select jsonb_build_object(
    'promptTokens', (request_totals.prompt_tokens + token_only_totals.prompt_tokens),
    'completionTokens', (request_totals.completion_tokens + token_only_totals.completion_tokens)
  )
  from request_totals cross join token_only_totals;
$$;

revoke all on function public.ai_token_usage_today(uuid)
  from public, anon, authenticated;
grant execute on function public.ai_token_usage_today(uuid) to service_role;

-- A six-argument completion can be called with token usage and no result to
-- accumulate an intermediate model call. A result or error code then closes
-- the same running row; old four-argument callers keep their old behavior.
create function public.finish_ai_request(
  p_owner uuid,
  p_request_id text,
  p_result jsonb,
  p_error_code text,
  p_prompt_tokens bigint,
  p_completion_tokens bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_request_id text;
  v_prompt bigint := coalesce(p_prompt_tokens, 0);
  v_completion bigint := coalesce(p_completion_tokens, 0);
  v_usage_only boolean;
begin
  if p_owner is null
    or p_request_id is null
    or p_request_id !~ '^[a-zA-Z0-9_-]{1,100}$'
    or (p_result is not null and (jsonb_typeof(p_result) <> 'object' or octet_length(p_result::text) > 262144))
    or (p_error_code is not null and p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$')
    or p_prompt_tokens is null
    or p_completion_tokens is null
    or v_prompt < 0
    or v_completion < 0
    or v_prompt > 9007199254740991
    or v_completion > 9007199254740991 then
    raise exception using errcode = '22023', message = 'Invalid AI request completion';
  end if;
  perform conuo_private.assert_account_access(p_owner);
  v_usage_only := p_result is null and p_error_code is null and (v_prompt > 0 or v_completion > 0);
  update public.ai_requests request set
    state = case
      when v_usage_only then request.state
      when p_result is null then 'failed'
      else 'completed'
    end,
    result = case when v_usage_only then request.result else p_result end,
    error_code = case
      when v_usage_only then request.error_code
      when p_result is null then p_error_code
      else null
    end,
    prompt_tokens = request.prompt_tokens + v_prompt,
    completion_tokens = request.completion_tokens + v_completion,
    updated_at = clock_timestamp()
  where request.owner_id = p_owner
    and request.request_id = p_request_id
    and (
      request.state = 'running'
      or (v_usage_only and request.state in ('completed','failed'))
    )
    and request.prompt_tokens <= 9007199254740991 - v_prompt
    and request.completion_tokens <= 9007199254740991 - v_completion
  returning request.request_id into v_request_id;
  if v_request_id is null then
    -- Business conflict SQLSTATE is PT409 after 20260920000300; keep the
    -- legacy four-argument caller's HTTP semantics unchanged.
    raise exception using errcode = 'PT409', message = 'AI request completion unavailable';
  end if;
  return jsonb_build_object('requestId', v_request_id);
end;
$$;

revoke all on function public.finish_ai_request(uuid,text,jsonb,text,bigint,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_ai_request(uuid,text,jsonb,text,bigint,bigint)
  to service_role;

-- Preserve the exact legacy RPC identity and failure semantics.
create or replace function public.finish_ai_request(
  p_owner uuid,
  p_request_id text,
  p_result jsonb default null,
  p_error_code text default null
) returns jsonb language sql security definer set search_path = '' as $$
  select public.finish_ai_request(p_owner, p_request_id, p_result, p_error_code, 0::bigint, 0::bigint);
$$;

revoke all on function public.finish_ai_request(uuid,text,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_ai_request(uuid,text,jsonb,text) to service_role;

commit;
