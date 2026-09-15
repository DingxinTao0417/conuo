-- Snapshot-compatible conversation projection. Workspace snapshots remain the sole
-- browser write authority; these tables provide a transactional, owner-isolated read model.
begin;

create table public.conversations (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  conversation_id text not null check (conversation_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  space_id text not null check (space_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  source_id text check (source_id is null or source_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  title text not null check (char_length(title) <= 512),
  scope text not null check (
    scope in ('selection','document','document-notes','sources','space','cross-library-sources')
  ),
  source_ids jsonb not null check (jsonb_typeof(source_ids) = 'array'),
  comparison jsonb check (comparison is null or jsonb_typeof(comparison) = 'object'),
  resolved boolean not null,
  updated_at timestamptz not null,
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  primary key (owner_id, conversation_id)
);

create table public.conversation_messages (
  owner_id uuid not null,
  conversation_id text not null,
  message_id text not null check (message_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  ordinal integer not null check (ordinal between 0 and 999),
  role text not null check (role in ('user','assistant')),
  content text not null check (octet_length(content) <= 3145728),
  citations jsonb not null check (jsonb_typeof(citations) = 'array'),
  note_evidence jsonb check (note_evidence is null or jsonb_typeof(note_evidence) = 'array'),
  created_at timestamptz not null,
  mode text check (mode is null or mode in ('extractive','model')),
  error text check (error is null or char_length(error) <= 10000),
  attempt_id text check (attempt_id is null or attempt_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  question_message_id text check (
    question_message_id is null or question_message_id ~ '^[a-zA-Z0-9_-]{1,100}$'
  ),
  attempt_scope_snapshot jsonb check (
    attempt_scope_snapshot is null or jsonb_typeof(attempt_scope_snapshot) = 'object'
  ),
  attempt_status text check (
    attempt_status is null or attempt_status in ('completed','failed','stopped')
  ),
  attempt_unavailable_reason text check (
    attempt_unavailable_reason is null or attempt_unavailable_reason = 'source-purged'
  ),
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  primary key (owner_id, conversation_id, message_id),
  foreign key (owner_id, conversation_id)
    references public.conversations(owner_id, conversation_id) on delete cascade,
  unique (owner_id, attempt_id),
  check (
    (attempt_id is null and question_message_id is null and attempt_scope_snapshot is null
      and attempt_status is null and attempt_unavailable_reason is null)
    or
    (attempt_id is not null and question_message_id is not null
      and attempt_scope_snapshot is not null and attempt_status is not null)
  )
);

create index conversations_owner_space_updated_at
  on public.conversations (owner_id, space_id, updated_at desc);
create index conversations_owner_source_updated_at
  on public.conversations (owner_id, source_id, updated_at desc)
  where source_id is not null;
create index conversation_messages_owner_conversation_ordinal
  on public.conversation_messages (owner_id, conversation_id, ordinal);

alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
revoke all on table public.conversations, public.conversation_messages
  from public, anon, authenticated, service_role;
grant select on table public.conversations, public.conversation_messages to authenticated;

create policy "Read own projected conversations" on public.conversations
  for select to authenticated
  using (owner_id = (select auth.uid()) and public.account_deletion_access_allowed());
create policy "Read own projected conversation messages" on public.conversation_messages
  for select to authenticated
  using (owner_id = (select auth.uid()) and public.account_deletion_access_allowed());

create function conuo_private.conversation_projection_digest(p_value jsonb)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_value::text, 'UTF8')), 'hex');
$$;

-- Invalid projection input aborts the enclosing workspace compare-and-swap. The projection
-- intentionally does not become a second writer or an authorization source for AI requests.
create function conuo_private.project_conversations_from_workspace(p_owner uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c jsonb;
  m jsonb;
  v_conversation_id text;
  v_message_id text;
  v_seen_conversations text[] := '{}';
  v_seen_messages text[];
  v_seen_attempts text[] := '{}';
  v_user_message_ids text[];
  v_source_ids text[];
  v_conversation_digest text;
  v_message_digest text;
  v_source_id text;
  v_comparison jsonb;
  v_note_evidence jsonb;
  v_mode text;
  v_error text;
  v_attempt jsonb;
  v_attempt_id text;
  v_question_message_id text;
  v_attempt_scope_snapshot jsonb;
  v_attempt_status text;
  v_attempt_unavailable_reason text;
begin
  if p_owner is null or p_data is null or jsonb_typeof(p_data) <> 'object'
    or jsonb_typeof(p_data->'conversations') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid conversation workspace';
  end if;
  if jsonb_array_length(p_data->'conversations') > 5000 then
    raise exception using errcode = '22023', message = 'Too many conversations';
  end if;

  for c in select value from jsonb_array_elements(p_data->'conversations') loop
    if jsonb_typeof(c) is distinct from 'object'
      or not conuo_private.valid_id(c->>'id')
      or c->>'id' = any(v_seen_conversations)
      or not conuo_private.valid_id(c->>'spaceId')
      or jsonb_typeof(c->'title') is distinct from 'string'
      or char_length(c->>'title') > 512
      or coalesce(c->>'scope' not in (
        'selection','document','document-notes','sources','space','cross-library-sources'
      ), true)
      or jsonb_typeof(c->'sourceIds') is distinct from 'array'
      or jsonb_array_length(c->'sourceIds') > 5000
      or jsonb_typeof(c->'messages') is distinct from 'array'
      or jsonb_array_length(c->'messages') > 1000
      or jsonb_typeof(c->'resolved') is distinct from 'boolean'
      or not (c ? 'updatedAt')
      or jsonb_typeof(c->'updatedAt') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Invalid conversation snapshot';
    end if;
    if c ? 'sourceId' and not conuo_private.valid_id(c->>'sourceId') then
      raise exception using errcode = '22023', message = 'Invalid conversation source';
    end if;
    if c ? 'comparison' then
      if jsonb_typeof(c->'comparison') is distinct from 'object'
        or not conuo_private.valid_id(c #>> '{comparison,leftSourceId}')
        or not conuo_private.valid_id(c #>> '{comparison,leftVersionId}')
        or not conuo_private.valid_id(c #>> '{comparison,rightSourceId}')
        or not conuo_private.valid_id(c #>> '{comparison,rightVersionId}')
        or c #>> '{comparison,leftSourceId}' = c #>> '{comparison,rightSourceId}' then
        raise exception using errcode = '22023', message = 'Invalid comparison conversation';
      end if;
    end if;

    select coalesce(array_agg(source_value #>> '{}' order by ordinality), '{}')
      into v_source_ids
      from jsonb_array_elements(c->'sourceIds') with ordinality as source(value, ordinality)
      cross join lateral (select source.value) selected(source_value)
      where jsonb_typeof(source_value) = 'string'
        and conuo_private.valid_id(source_value #>> '{}');
    if cardinality(v_source_ids) <> jsonb_array_length(c->'sourceIds') then
      raise exception using errcode = '22023', message = 'Invalid conversation source list';
    end if;
    if c->>'scope' = 'cross-library-sources' and (
      c->>'spaceId' <> 'all' or c ? 'sourceId' or c ? 'comparison'
      or cardinality(v_source_ids) not between 1 and 5
      or cardinality(v_source_ids) <> cardinality(array(select distinct unnest(v_source_ids)))
    ) then
      raise exception using errcode = '22023', message = 'Invalid cross-library conversation';
    end if;
    if c ? 'comparison' and (
      c->>'scope' <> 'sources' or c ? 'sourceId' or cardinality(v_source_ids) <> 2
      or cardinality(v_source_ids) <> cardinality(array(select distinct unnest(v_source_ids)))
      or not ((c #>> '{comparison,leftSourceId}') = any(v_source_ids))
      or not ((c #>> '{comparison,rightSourceId}') = any(v_source_ids))
    ) then
      raise exception using errcode = '22023', message = 'Comparison conversation range mismatch';
    end if;

    v_conversation_id := c->>'id';
    v_seen_conversations := array_append(v_seen_conversations, v_conversation_id);
    v_source_id := case when c ? 'sourceId' then c->>'sourceId' else null end;
    v_comparison := case when c ? 'comparison' then c->'comparison' else null end;
    v_conversation_digest := conuo_private.conversation_projection_digest(c - 'messages');

    insert into public.conversations (
      owner_id, conversation_id, space_id, source_id, title, scope, source_ids,
      comparison, resolved, updated_at, snapshot_digest
    ) values (
      p_owner, v_conversation_id, c->>'spaceId', v_source_id, c->>'title', c->>'scope',
      c->'sourceIds', v_comparison, (c->>'resolved')::boolean,
      (c->>'updatedAt')::timestamptz, v_conversation_digest
    )
    on conflict (owner_id, conversation_id) do update set
      space_id = excluded.space_id,
      source_id = excluded.source_id,
      title = excluded.title,
      scope = excluded.scope,
      source_ids = excluded.source_ids,
      comparison = excluded.comparison,
      resolved = excluded.resolved,
      updated_at = excluded.updated_at,
      snapshot_digest = excluded.snapshot_digest
    where public.conversations.snapshot_digest is distinct from excluded.snapshot_digest;

    select coalesce(array_agg(message.value->>'id' order by message.ordinality), '{}')
      into v_user_message_ids
      from jsonb_array_elements(c->'messages') with ordinality as message(value, ordinality)
      where message.value->>'role' = 'user'
        and conuo_private.valid_id(message.value->>'id');

    v_seen_messages := '{}';
    for m in select value from jsonb_array_elements(c->'messages') loop
      if jsonb_typeof(m) is distinct from 'object'
        or not conuo_private.valid_id(m->>'id')
        or m->>'id' = any(v_seen_messages)
        or coalesce(m->>'role' not in ('user','assistant'), true)
        or jsonb_typeof(m->'content') is distinct from 'string'
        or octet_length(m->>'content') > 3145728
        or jsonb_typeof(m->'citations') is distinct from 'array'
        or jsonb_array_length(m->'citations') > 1000
        or not (m ? 'createdAt')
        or jsonb_typeof(m->'createdAt') is distinct from 'string' then
        raise exception using errcode = '22023', message = 'Invalid conversation message';
      end if;
      if m ? 'noteEvidence' and (
        jsonb_typeof(m->'noteEvidence') is distinct from 'array'
        or jsonb_array_length(m->'noteEvidence') > 12
      ) then
        raise exception using errcode = '22023', message = 'Invalid message note evidence';
      end if;
      if m ? 'mode' and coalesce(m->>'mode' not in ('extractive','model'), true) then
        raise exception using errcode = '22023', message = 'Invalid message mode';
      end if;
      if m ? 'error' and (
        jsonb_typeof(m->'error') is distinct from 'string'
        or char_length(m->>'error') > 10000
      ) then
        raise exception using errcode = '22023', message = 'Invalid message error';
      end if;

      v_attempt := case when m ? 'attempt' then m->'attempt' else null end;
      if v_attempt is not null then
        if jsonb_typeof(v_attempt) is distinct from 'object'
          or m->>'role' <> 'assistant'
          or not conuo_private.valid_id(v_attempt->>'id')
          or v_attempt->>'id' = any(v_seen_attempts)
          or not conuo_private.valid_id(v_attempt->>'questionMessageId')
          or not ((v_attempt->>'questionMessageId') = any(v_user_message_ids))
          or jsonb_typeof(v_attempt->'scopeSnapshot') is distinct from 'object'
          or coalesce(v_attempt->>'status' not in ('completed','failed','stopped'), true)
          or (v_attempt ? 'unavailableReason'
            and v_attempt->>'unavailableReason' is distinct from 'source-purged') then
          raise exception using errcode = '22023', message = 'Invalid answer attempt snapshot';
        end if;
        v_attempt_id := v_attempt->>'id';
        v_seen_attempts := array_append(v_seen_attempts, v_attempt_id);
        v_question_message_id := v_attempt->>'questionMessageId';
        v_attempt_scope_snapshot := v_attempt->'scopeSnapshot';
        v_attempt_status := v_attempt->>'status';
        v_attempt_unavailable_reason := case
          when v_attempt ? 'unavailableReason' then v_attempt->>'unavailableReason' else null
        end;
      else
        v_attempt_id := null;
        v_question_message_id := null;
        v_attempt_scope_snapshot := null;
        v_attempt_status := null;
        v_attempt_unavailable_reason := null;
      end if;

      v_message_id := m->>'id';
      v_seen_messages := array_append(v_seen_messages, v_message_id);
      v_note_evidence := case when m ? 'noteEvidence' then m->'noteEvidence' else null end;
      v_mode := case when m ? 'mode' then m->>'mode' else null end;
      v_error := case when m ? 'error' then m->>'error' else null end;
      v_message_digest := conuo_private.conversation_projection_digest(m);

      insert into public.conversation_messages (
        owner_id, conversation_id, message_id, ordinal, role, content, citations,
        note_evidence, created_at, mode, error, attempt_id, question_message_id,
        attempt_scope_snapshot, attempt_status, attempt_unavailable_reason, snapshot_digest
      ) values (
        p_owner, v_conversation_id, v_message_id, cardinality(v_seen_messages) - 1,
        m->>'role', m->>'content', m->'citations', v_note_evidence,
        (m->>'createdAt')::timestamptz, v_mode, v_error, v_attempt_id,
        v_question_message_id, v_attempt_scope_snapshot, v_attempt_status,
        v_attempt_unavailable_reason, v_message_digest
      )
      on conflict (owner_id, conversation_id, message_id) do update set
        ordinal = excluded.ordinal,
        role = excluded.role,
        content = excluded.content,
        citations = excluded.citations,
        note_evidence = excluded.note_evidence,
        created_at = excluded.created_at,
        mode = excluded.mode,
        error = excluded.error,
        attempt_id = excluded.attempt_id,
        question_message_id = excluded.question_message_id,
        attempt_scope_snapshot = excluded.attempt_scope_snapshot,
        attempt_status = excluded.attempt_status,
        attempt_unavailable_reason = excluded.attempt_unavailable_reason,
        snapshot_digest = excluded.snapshot_digest
      where public.conversation_messages.snapshot_digest is distinct from excluded.snapshot_digest
        or public.conversation_messages.ordinal is distinct from excluded.ordinal;
    end loop;

    delete from public.conversation_messages message_row
      where message_row.owner_id = p_owner
        and message_row.conversation_id = v_conversation_id
        and not (message_row.message_id = any(v_seen_messages));
  end loop;

  delete from public.conversations conversation_row
    where conversation_row.owner_id = p_owner
      and not (conversation_row.conversation_id = any(v_seen_conversations));
end;
$$;

create function conuo_private.project_conversations_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform conuo_private.project_conversations_from_workspace(new.owner_id, new.data);
  return new;
end;
$$;

create trigger project_workspace_conversations
after insert or update of data on public.workspaces
for each row execute function conuo_private.project_conversations_from_workspace_trigger();

-- Existing snapshots are projected under the same per-owner advisory lock used by the
-- canonical source and note projections. Account-deletion fences do not skip schema backfill.
do $$
declare w record;
begin
  for w in select owner_id, data from public.workspaces loop
    perform pg_advisory_xact_lock(hashtextextended('conuo:source:' || w.owner_id::text, 0));
    perform conuo_private.project_conversations_from_workspace(w.owner_id, w.data);
  end loop;
end;
$$;

revoke all on function conuo_private.conversation_projection_digest(jsonb),
  conuo_private.project_conversations_from_workspace(uuid,jsonb),
  conuo_private.project_conversations_from_workspace_trigger()
  from public, anon, authenticated, service_role;

comment on table public.conversations is
  'Read projection of workspaces.data.conversations; workspace snapshots remain the write authority.';
comment on table public.conversation_messages is
  'Ordered read projection of conversation messages, citations, note evidence, and answer attempts.';
commit;
