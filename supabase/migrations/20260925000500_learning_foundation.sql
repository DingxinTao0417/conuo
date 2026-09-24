begin;

create table public.learning_items (
  owner_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null check (item_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  space_id text not null check (space_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  kind text not null check (kind in ('recall','choice','cloze','short','derivation','explain')),
  prompt text not null check (char_length(prompt) between 1 and 2000),
  choices jsonb check (choices is null or (jsonb_typeof(choices) = 'array' and jsonb_array_length(choices) between 2 and 6)),
  answer jsonb not null check (jsonb_typeof(answer) = 'object' and octet_length(answer::text) <= 16384),
  explanation text check (explanation is null or char_length(explanation) <= 4000),
  citations jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array' and jsonb_array_length(citations) <= 6),
  origin text not null check (origin in ('ai','user','region')),
  origin_ref jsonb check (origin_ref is null or (jsonb_typeof(origin_ref) = 'object' and octet_length(origin_ref::text) <= 2048)),
  concept_key text check (concept_key is null or char_length(concept_key) between 1 and 120),
  hints jsonb check (hints is null or (jsonb_typeof(hints) = 'array' and jsonb_array_length(hints) <= 3)),
  status text not null default 'active' check (status in ('active','suspended','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, item_id)
);
create index learning_items_space on public.learning_items(owner_id, space_id, created_at);

create table public.review_states (
  owner_id uuid not null,
  item_id text not null,
  card jsonb not null check (jsonb_typeof(card) = 'object' and octet_length(card::text) <= 4096),
  due_at timestamptz not null,
  reps integer not null default 0 check (reps >= 0),
  lapses integer not null default 0 check (lapses >= 0),
  last_review_at timestamptz,
  version integer not null default 0 check (version >= 0),
  primary key (owner_id, item_id),
  foreign key (owner_id, item_id) references public.learning_items on delete cascade
);
create index review_states_due on public.review_states(owner_id, due_at);

create table public.review_logs (
  owner_id uuid not null,
  log_id text not null check (log_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  item_id text not null,
  rating smallint not null check (rating between 1 and 4),
  answer_text text check (answer_text is null or char_length(answer_text) <= 4000),
  grade jsonb check (grade is null or (jsonb_typeof(grade) = 'object' and octet_length(grade::text) <= 16384)),
  elapsed_ms integer check (elapsed_ms is null or elapsed_ms between 0 and 86400000),
  reviewed_at timestamptz not null default now(),
  primary key (owner_id, log_id),
  foreign key (owner_id, item_id) references public.learning_items on delete cascade
);

create table public.learning_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  daily_new_limit integer not null default 20 check (daily_new_limit between 0 and 200),
  desired_retention numeric(3,2) not null default 0.90 check (desired_retention between 0.70 and 0.97),
  paused boolean not null default false,
  updated_at timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['learning_items','review_states','review_logs','learning_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

create function conuo_private.learning_item_json(p_item public.learning_items, p_state public.review_states default null)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'itemId', p_item.item_id, 'spaceId', p_item.space_id, 'kind', p_item.kind,
    'prompt', p_item.prompt, 'choices', p_item.choices, 'answer', p_item.answer,
    'explanation', p_item.explanation, 'citations', p_item.citations, 'origin', p_item.origin,
    'originRef', p_item.origin_ref, 'conceptKey', p_item.concept_key, 'hints', p_item.hints,
    'status', p_item.status, 'createdAt', p_item.created_at, 'updatedAt', p_item.updated_at,
    'deletedAt', p_item.deleted_at,
    'card', case when p_state is null then null else p_state.card end,
    'dueAt', case when p_state is null then null else p_state.due_at end,
    'version', case when p_state is null then null else p_state.version end,
    'reps', case when p_state is null then null else p_state.reps end,
    'lapses', case when p_state is null then null else p_state.lapses end,
    'lastReviewAt', case when p_state is null then null else p_state.last_review_at end
  );
$$;

create function public.upsert_learning_items(p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid(); v_item jsonb; v_item_id text; v_existing public.learning_items; v_state public.review_states;
  v_result jsonb := '[]'::jsonb; v_due timestamptz;
begin
  if v_owner is null then raise exception using errcode='42501', message='Authentication required'; end if;
  perform conuo_private.assert_account_access(v_owner);
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 20 then
    raise exception using errcode='22023', message='Invalid learning item batch';
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_item_id := v_item->>'itemId';
    if v_item_id is null or v_item_id !~ '^[a-zA-Z0-9_-]{1,100}$'
      or v_item->>'spaceId' !~ '^[a-zA-Z0-9_-]{1,100}$'
      or v_item->>'kind' not in ('recall','choice','cloze','short','derivation','explain')
      or char_length(coalesce(v_item->>'prompt','')) not between 1 and 2000
      or jsonb_typeof(v_item->'answer') <> 'object'
      or octet_length((v_item->'answer')::text) > 16384
      or v_item->>'origin' not in ('ai','user','region')
      or v_item->>'status' not in ('active','suspended','archived')
      or jsonb_typeof(v_item->'citations') <> 'array'
      or jsonb_array_length(v_item->'citations') > 6
      or v_item->>'card' is null or jsonb_typeof(v_item->'card') <> 'object'
      or octet_length((v_item->'card')::text) > 4096
      or v_item->>'dueAt' is null then
      raise exception using errcode='22023', message='Invalid learning item';
    end if;
    v_due := (v_item->>'dueAt')::timestamptz;
    select * into v_existing from public.learning_items where owner_id=v_owner and item_id=v_item_id for update;
    if found then
      update public.learning_items set space_id=v_item->>'spaceId', kind=v_item->>'kind', prompt=v_item->>'prompt',
        choices=v_item->'choices', answer=v_item->'answer', explanation=v_item->>'explanation',
        citations=v_item->'citations', concept_key=nullif(v_item->>'conceptKey',''), hints=v_item->'hints',
        status=v_item->>'status', updated_at=now()
        where owner_id=v_owner and item_id=v_item_id;
    else
      insert into public.learning_items(owner_id,item_id,space_id,kind,prompt,choices,answer,explanation,citations,origin,origin_ref,concept_key,hints,status)
      values(v_owner,v_item_id,v_item->>'spaceId',v_item->>'kind',v_item->>'prompt',v_item->'choices',v_item->'answer',v_item->>'explanation',v_item->'citations',v_item->>'origin',v_item->'originRef',nullif(v_item->>'conceptKey',''),v_item->'hints',v_item->>'status');
      insert into public.review_states(owner_id,item_id,card,due_at) values(v_owner,v_item_id,v_item->'card',v_due);
    end if;
    select i.* into v_existing from public.learning_items i
      where i.owner_id=v_owner and i.item_id=v_item_id;
    select s.* into v_state from public.review_states s
      where s.owner_id=v_owner and s.item_id=v_item_id;
    v_result := v_result || jsonb_build_array(conuo_private.learning_item_json(v_existing,v_state));
  end loop;
  return v_result;
end;
$$;

create function public.list_learning_items(p_space_id text, p_status text default null, p_limit integer default 100, p_before timestamptz default null)
returns setof jsonb language sql security definer set search_path = '' as $$
  select conuo_private.learning_item_json(i,s)
  from public.learning_items i join public.review_states s using(owner_id,item_id)
  where i.owner_id=auth.uid() and i.deleted_at is null
    and (p_space_id is null or i.space_id=p_space_id) and (p_status is null or i.status=p_status)
    and (p_before is null or i.created_at < p_before)
  order by i.created_at desc, i.item_id desc limit least(greatest(coalesce(p_limit,100),1),100);
$$;

create function public.due_review_items(p_space_id text, p_limit integer default 20)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_paused boolean; v_limit integer; v_new integer;
begin
  perform conuo_private.assert_account_access(v_owner);
  select paused,daily_new_limit into v_paused,v_limit from public.learning_settings where owner_id=v_owner;
  if coalesce(v_paused,false) then return; end if;
  select count(*)::integer into v_new from public.review_states s join public.learning_items i using(owner_id,item_id)
    where s.owner_id=v_owner and i.space_id=p_space_id and i.deleted_at is null and i.status='active' and s.reps=0 and s.due_at <= now();
  return query select conuo_private.learning_item_json(i,s)
    from public.learning_items i join public.review_states s using(owner_id,item_id)
    where i.owner_id=v_owner and i.space_id=p_space_id and i.deleted_at is null and i.status='active'
      and s.due_at <= now() and (
        s.reps > 0 or v_new <= coalesce(v_limit,20) or s.item_id in (
          select limited.item_id from public.review_states limited
          join public.learning_items limited_item using(owner_id,item_id)
          where limited.owner_id=v_owner and limited_item.space_id=p_space_id
            and limited_item.deleted_at is null and limited_item.status='active'
            and limited.reps=0 and limited.due_at <= now()
          order by limited.due_at, limited.item_id limit greatest(coalesce(v_limit,20),0)
        )
      )
    order by s.due_at, i.created_at limit least(greatest(coalesce(p_limit,20),1),100);
end;
$$;

create function public.record_review(p_item_id text, p_log jsonb, p_next_card jsonb, p_due_at timestamptz, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_state public.review_states; v_item public.learning_items; v_rating integer; v_log_id text;
begin
  perform conuo_private.assert_account_access(v_owner);
  select * into v_state from public.review_states where owner_id=v_owner and item_id=p_item_id for update;
  if not found then raise exception using errcode='22023', message='Learning item unavailable'; end if;
  if v_state.version <> p_expected_version then raise exception using errcode='40001', message='Learning review version conflict'; end if;
  if jsonb_typeof(p_next_card)<>'object' or octet_length(p_next_card::text)>4096 or p_due_at is null
    or jsonb_typeof(p_log)<>'object' then raise exception using errcode='22023', message='Invalid learning review'; end if;
  v_rating := (p_log->>'rating')::integer; v_log_id := p_log->>'logId';
  if v_rating not between 1 and 4 or v_log_id is null or v_log_id !~ '^[a-zA-Z0-9_-]{1,100}$' then raise exception using errcode='22023', message='Invalid learning review'; end if;
  insert into public.review_logs(owner_id,log_id,item_id,rating,answer_text,grade,elapsed_ms) values(v_owner,v_log_id,p_item_id,v_rating,p_log->>'answerText',p_log->'grade',(p_log->>'elapsedMs')::integer);
  update public.review_states set card=p_next_card,due_at=p_due_at,reps=greatest(0,coalesce((p_next_card->>'reps')::integer, reps)),
    lapses=greatest(0,coalesce((p_next_card->>'lapses')::integer, lapses)),last_review_at=now(),version=version+1
    where owner_id=v_owner and item_id=p_item_id returning * into v_state;
  select * into v_item from public.learning_items where owner_id=v_owner and item_id=p_item_id;
  return conuo_private.learning_item_json(v_item,v_state);
end;
$$;

create function public.set_learning_item_status(p_item_id text, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_item public.learning_items;
begin
  if p_status not in ('active','suspended','archived') then raise exception using errcode='22023',message='Invalid learning status'; end if;
  update public.learning_items set status=p_status, updated_at=now()
    where owner_id=auth.uid() and item_id=p_item_id and deleted_at is null returning * into v_item;
  if not found then raise exception using errcode='22023',message='Learning item unavailable'; end if;
  return conuo_private.learning_item_json(v_item,null);
end;
$$;

create function public.delete_learning_item(p_item_id text)
returns boolean language sql security definer set search_path = '' as $$
  update public.learning_items set deleted_at=now(), status='archived', updated_at=now()
    where owner_id=auth.uid() and item_id=p_item_id and deleted_at is null returning true;
$$;

create function public.get_learning_settings() returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('dailyNewLimit',daily_new_limit,'desiredRetention',desired_retention,'paused',paused)
  from public.learning_settings where owner_id=auth.uid();
$$;

create function public.save_learning_settings(p_settings jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_row public.learning_settings;
begin
  perform conuo_private.assert_account_access(v_owner);
  if jsonb_typeof(p_settings)<>'object' then raise exception using errcode='22023',message='Invalid learning settings'; end if;
  insert into public.learning_settings(owner_id,daily_new_limit,desired_retention,paused)
    values(v_owner,(p_settings->>'dailyNewLimit')::integer,(p_settings->>'desiredRetention')::numeric,(p_settings->>'paused')::boolean)
    on conflict(owner_id) do update set daily_new_limit=excluded.daily_new_limit,desired_retention=excluded.desired_retention,paused=excluded.paused,updated_at=now()
    returning * into v_row;
  return jsonb_build_object('dailyNewLimit',v_row.daily_new_limit,'desiredRetention',v_row.desired_retention,'paused',v_row.paused);
end;
$$;

create function public.learning_overview(p_space_id text) returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'dueCount', count(*) filter (where s.due_at <= now()),
    'newCount', count(*) filter (where s.reps=0),
    'reviewsLast7d', (select count(*) from public.review_logs l join public.learning_items li using(owner_id,item_id) where l.owner_id=auth.uid() and li.space_id=p_space_id and l.reviewed_at >= now()-interval '7 days'),
    'weakConcepts', '[]'::jsonb
  ) from public.learning_items i join public.review_states s using(owner_id,item_id)
  where i.owner_id=auth.uid() and i.space_id=p_space_id and i.deleted_at is null and i.status='active';
$$;

create function conuo_private.purge_learning_source_citations() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_version text:=new.version_id; v_scope text:=new.purge_scope;
begin
  if coalesce(v_scope,'source')='source' then v_version:=null; end if;
  update public.learning_items li set
    citations=(select coalesce(jsonb_agg(c.value order by c.ordinality),'[]'::jsonb)
      from jsonb_array_elements(li.citations) with ordinality c(value,ordinality)
      where not (c.value->>'sourceId'=new.source_id and (v_version is null or c.value->>'versionId'=v_version))),
    origin_ref=coalesce(li.origin_ref,'{}'::jsonb)||'{"sourcePurged":true}'::jsonb,
    updated_at=now()
  where li.owner_id=new.owner_id and li.deleted_at is null
    and exists (select 1 from jsonb_array_elements(li.citations) c(value)
      where c.value->>'sourceId'=new.source_id and (v_version is null or c.value->>'versionId'=v_version));
  return new;
end;
$$;
create trigger source_purge_learning_citations after insert on public.source_purges
  for each row execute function conuo_private.purge_learning_source_citations();

do $$ declare fn text; begin
  foreach fn in array array['upsert_learning_items(jsonb)','list_learning_items(text,text,integer,timestamptz)','due_review_items(text,integer)','record_review(text,jsonb,jsonb,timestamptz,integer)','set_learning_item_status(text,text)','delete_learning_item(text)','get_learning_settings()','save_learning_settings(jsonb)','learning_overview(text)'] loop
    execute format('revoke all on function public.%s from public, anon, service_role', fn);
  end loop;
end $$;
grant execute on function public.upsert_learning_items(jsonb), public.list_learning_items(text,text,integer,timestamptz), public.due_review_items(text,integer), public.record_review(text,jsonb,jsonb,timestamptz,integer), public.set_learning_item_status(text,text), public.delete_learning_item(text), public.get_learning_settings(), public.save_learning_settings(jsonb), public.learning_overview(text) to authenticated;

commit;
