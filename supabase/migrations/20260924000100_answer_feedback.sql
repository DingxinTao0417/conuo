begin;

create table public.answer_feedback (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (request_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  conversation_id text check (conversation_id is null or conversation_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  message_id text check (message_id is null or message_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  rating text not null check (rating in ('up','down')),
  reasons text[] not null default '{}' check (
    cardinality(reasons) <= 8 and reasons <@ array[
      'wrong_citation','not_answered','incorrect','incomplete',
      'format','too_long','grading_wrong','other']::text[]),
  comment text check (comment is null or char_length(comment) <= 500),
  include_content boolean not null default false,
  question text check (question is null or char_length(question) <= 4000),
  answer text check (answer is null or char_length(answer) <= 50000),
  contract_version text check (contract_version is null or contract_version ~ '^[a-zA-Z0-9._-]{1,100}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, request_id),
  check ((include_content and question is not null and answer is not null)
    or (not include_content and question is null and answer is null))
);

alter table public.answer_feedback enable row level security;
revoke all on table public.answer_feedback from public, anon, authenticated, service_role;
grant select on table public.answer_feedback to service_role;

create function public.submit_answer_feedback(p_feedback jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_include_content boolean;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  perform conuo_private.assert_account_access(v_owner);
  if jsonb_typeof(p_feedback) is distinct from 'object'
     or octet_length(p_feedback::text) > 65536 then
    raise exception using errcode = '22023', message = 'Invalid feedback';
  end if;
  v_include_content := coalesce((p_feedback->>'includeContent')::boolean, false);
  insert into public.answer_feedback (
    owner_id, request_id, conversation_id, message_id, rating, reasons, comment,
    include_content, question, answer, contract_version
  ) values (
    v_owner,
    p_feedback->>'requestId',
    p_feedback->>'conversationId',
    p_feedback->>'messageId',
    p_feedback->>'rating',
    coalesce(array(select jsonb_array_elements_text(p_feedback->'reasons')), '{}'::text[]),
    p_feedback->>'comment',
    v_include_content,
    p_feedback->>'question',
    p_feedback->>'answer',
    p_feedback->>'contractVersion'
  )
  on conflict (owner_id, request_id) do update set
    conversation_id = excluded.conversation_id,
    message_id = excluded.message_id,
    rating = excluded.rating,
    reasons = excluded.reasons,
    comment = excluded.comment,
    include_content = excluded.include_content,
    question = excluded.question,
    answer = excluded.answer,
    contract_version = excluded.contract_version,
    updated_at = now();
  return jsonb_build_object('requestId', p_feedback->>'requestId');
exception when invalid_text_representation or check_violation or not_null_violation then
  raise exception using errcode = '22023', message = 'Invalid feedback';
end;
$$;

create function public.withdraw_answer_feedback(p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  perform conuo_private.assert_account_access(v_owner);
  delete from public.answer_feedback
    where owner_id = v_owner and request_id = p_request_id;
  return jsonb_build_object('requestId', p_request_id);
end;
$$;

revoke all on function public.submit_answer_feedback(jsonb) from public, anon;
grant execute on function public.submit_answer_feedback(jsonb) to authenticated;
revoke all on function public.withdraw_answer_feedback(text) from public, anon;
grant execute on function public.withdraw_answer_feedback(text) to authenticated;

commit;
