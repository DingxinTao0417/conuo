-- DAT03: explicitly selected saved notes/knowledge pages and conversations are
-- removed with a source in one transaction. Their identities remain fenced for
-- this owner; retaining a conversation keeps its frozen personal-note evidence.
begin;

create table conuo_private.saved_content_tombstones (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  kind text not null check (kind in ('note','conversation')),
  content_id text not null check (content_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  purge_id uuid not null,
  workspace_revision bigint not null check (workspace_revision > 0),
  purged_at timestamptz not null default now(),
  primary key (owner_id, kind, content_id)
);
alter table conuo_private.saved_content_tombstones enable row level security;
revoke all on table conuo_private.saved_content_tombstones from public, anon, authenticated, service_role;

-- The snapshot is the only production write authority. This additive trigger
-- covers the latest fast save, worker RPCs and privileged direct snapshot UPDATE
-- without replacing their lease, account, owner-lock or CAS implementations.
create function conuo_private.fence_saved_content_on_workspace_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from jsonb_array_elements(conuo_private.json_array(new.data->'notes')) item(value)
    join conuo_private.saved_content_tombstones tombstone
      on tombstone.owner_id = new.owner_id and tombstone.kind = 'note'
      and tombstone.content_id = item.value->>'id'
    union all
    select 1 from jsonb_array_elements(conuo_private.json_array(new.data->'conversations')) item(value)
    join conuo_private.saved_content_tombstones tombstone
      on tombstone.owner_id = new.owner_id and tombstone.kind = 'conversation'
      and tombstone.content_id = item.value->>'id'
  ) then
    raise exception using errcode = '40001', message = 'Saved content was permanently deleted';
  end if;
  return new;
end;
$$;
create trigger fence_saved_content_on_workspace_write
before insert or update of data on public.workspaces
for each row execute function conuo_private.fence_saved_content_on_workspace_write();

create function conuo_private.note_source_reference_count(p_note jsonb, p_source_id text)
returns integer language sql immutable set search_path = '' as $$
  select coalesce(sum(conuo_private.purge_citation_count(snapshot.value->'citations', p_source_id)
    + conuo_private.purge_citation_count(snapshot.value->'manualExcerptRefs', p_source_id)), 0)::integer
  from (
    select p_note as value
    union all
    select value from jsonb_array_elements(conuo_private.json_array(p_note->'versions'))
  ) snapshot;
$$;

create function conuo_private.scope_references_purged_source(p_scope jsonb, p_source_id text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_scope->>'sourceId' = p_source_id, false)
    or exists (select 1 from jsonb_array_elements(conuo_private.json_array(p_scope->'sourceIds')) item(value)
      where item.value #>> '{}' = p_source_id)
    or exists (select 1 from jsonb_array_elements(conuo_private.json_array(p_scope->'sourceVersions')) item(value)
      where item.value->>'sourceId' = p_source_id)
    or coalesce(p_scope #>> '{comparison,leftSourceId}' = p_source_id, false)
    or coalesce(p_scope #>> '{comparison,rightSourceId}' = p_source_id, false);
$$;

create function conuo_private.conversation_source_reference_count(p_conversation jsonb, p_source_id text)
returns integer language sql immutable set search_path = '' as $$
  select coalesce(sum(conuo_private.purge_citation_count(message.value->'citations', p_source_id)
    + conuo_private.purge_note_evidence_count(message.value->'noteEvidence', p_source_id)), 0)::integer
  from jsonb_array_elements(conuo_private.json_array(p_conversation->'messages')) message(value);
$$;

create function conuo_private.conversation_references_purged_source(p_conversation jsonb, p_source_id text)
returns boolean language sql immutable set search_path = '' as $$
  select conuo_private.scope_references_purged_source(p_conversation, p_source_id)
    or conuo_private.conversation_source_reference_count(p_conversation, p_source_id) > 0
    or exists (select 1 from jsonb_array_elements(conuo_private.json_array(p_conversation->'messages')) message(value)
      where conuo_private.scope_references_purged_source(message.value #> '{attempt,scopeSnapshot}', p_source_id));
$$;

-- Only explicit structured note identities count. Text bodies that happen to
-- contain an ID (or JSON-looking text) are never interpreted as dependencies.
create function conuo_private.content_references_selected_notes(p_value jsonb, p_note_ids text[])
returns boolean language plpgsql immutable set search_path = '' as $$
declare item record; child jsonb;
begin
  if cardinality(p_note_ids) = 0 or p_value is null then return false; end if;
  if jsonb_typeof(p_value) = 'object' then
    if p_value->>'noteId' = any(p_note_ids) or p_value->>'targetNoteId' = any(p_note_ids) then return true; end if;
    for item in select key,value from jsonb_each(p_value) loop
      if item.key in ('targetNote','compareNote','target','compare','note','from','to')
        and jsonb_typeof(item.value) = 'object' and item.value->>'kind' is distinct from 'source'
        and item.value->>'id' = any(p_note_ids) then return true; end if;
      if conuo_private.content_references_selected_notes(item.value, p_note_ids) then return true; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for child in select value from jsonb_array_elements(p_value) loop
      if conuo_private.content_references_selected_notes(child, p_note_ids) then return true; end if;
    end loop;
  end if;
  return false;
end;
$$;

create function conuo_private.relation_references_selected_notes(p_relation jsonb, p_note_ids text[])
returns boolean language sql immutable set search_path = '' as $$
  select (p_relation #>> '{from,kind}' is distinct from 'source'
    and coalesce(p_relation #>> '{from,id}' = any(p_note_ids), false))
    or (p_relation #>> '{to,kind}' is distinct from 'source'
      and coalesce(p_relation #>> '{to,id}' = any(p_note_ids), false));
$$;

create function conuo_private.content_references_purged_source(p_value jsonb,p_source_id text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare child jsonb;
begin
  if jsonb_typeof(p_value) = 'object' then
    if p_value->>'sourceId' = p_source_id or p_value->>'leftSourceId' = p_source_id
      or p_value->>'rightSourceId' = p_source_id or exists (
        select 1 from jsonb_array_elements(conuo_private.json_array(p_value->'sourceIds')) item(value)
        where item.value #>> '{}' = p_source_id
      ) then return true; end if;
    for child in select value from jsonb_each(p_value) loop
      if conuo_private.content_references_purged_source(child,p_source_id) then return true; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for child in select value from jsonb_array_elements(p_value) loop
      if conuo_private.content_references_purged_source(child,p_source_id) then return true; end if;
    end loop;
  end if;
  return false;
end;
$$;
-- Restored generated work may reference a source in its frozen result/review,
-- independently of the request's current source list. Match the domain's
-- structured provenance traversal; never parse an authored string as JSON.
create or replace function conuo_private.organization_job_references_purged_source(p_job jsonb,p_source_id text)
returns boolean language sql immutable set search_path = '' as $$
  select conuo_private.content_references_purged_source(p_job,p_source_id);
$$;

create function conuo_private.organization_task_references_purge(
  p_job jsonb,p_snapshot_jobs jsonb,p_source_id text,p_note_ids text[]
) returns boolean language sql immutable set search_path = '' as $$
  select conuo_private.content_references_purged_source(p_job->'request',p_source_id)
    or conuo_private.content_references_purged_source(p_job->'result',p_source_id)
    or conuo_private.content_references_selected_notes(p_job->'request',p_note_ids)
    or conuo_private.content_references_selected_notes(p_job->'result',p_note_ids)
    or exists (select 1 from jsonb_array_elements(conuo_private.json_array(p_snapshot_jobs)) item(value)
      where item.value->>'id' = p_job->>'job_id' and (
        conuo_private.organization_job_references_purged_source(item.value,p_source_id)
        or conuo_private.content_references_selected_notes(item.value,p_note_ids)));
$$;

-- Keep the previous sanitizer's complete authored-body/reference semantics.
-- Repair comparison ranges: a historical pair remains an unavailable pair,
-- rather than retaining comparison metadata with only one source ID.
alter function conuo_private.sanitize_purged_source_workspace(jsonb,text)
  rename to sanitize_purged_source_workspace_before_content_selection;
create function conuo_private.sanitize_purged_source_workspace(p_data jsonb, p_source_id text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_data jsonb; v_conversations jsonb;
begin
  v_data := conuo_private.sanitize_purged_source_workspace_before_content_selection(p_data, p_source_id);
  select coalesce(jsonb_agg(
    (sanitized.value - 'messages') ||
    case when original.value ? 'comparison' then jsonb_build_object('sourceIds', original.value->'sourceIds') else '{}'::jsonb end ||
    jsonb_build_object('messages', coalesce((
      select jsonb_agg(
        case when conuo_private.scope_references_purged_source(message.value #> '{attempt,scopeSnapshot}', p_source_id)
          then jsonb_set(message.value, '{attempt}', (message.value->'attempt') || jsonb_build_object('unavailableReason','source-purged'))
          else message.value end order by message.ordinality)
      from jsonb_array_elements(conuo_private.json_array(sanitized.value->'messages')) with ordinality message(value,ordinality)
    ), '[]'::jsonb)) order by sanitized.ordinality), '[]'::jsonb)
    into v_conversations
    from jsonb_array_elements(conuo_private.json_array(v_data->'conversations')) with ordinality sanitized(value,ordinality)
    join jsonb_array_elements(conuo_private.json_array(p_data->'conversations')) original(value)
      on original.value->>'id' = sanitized.value->>'id';
  return jsonb_set(v_data, '{conversations}', v_conversations);
end;
$$;

create function conuo_private.sanitize_source_purge_selection(
  p_data jsonb, p_source_id text, p_note_ids text[], p_conversation_ids text[]
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_data jsonb; v_notes jsonb; v_conversations jsonb; v_jobs jsonb; v_relations jsonb;
begin
  v_data := conuo_private.sanitize_purged_source_workspace(p_data, p_source_id);
  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb) into v_notes
    from jsonb_array_elements(conuo_private.json_array(v_data->'notes')) with ordinality item(value,ordinality)
    where not (item.value->>'id' = any(p_note_ids));
  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb) into v_conversations
    from jsonb_array_elements(conuo_private.json_array(v_data->'conversations')) with ordinality item(value,ordinality)
    where not (item.value->>'id' = any(p_conversation_ids));
  v_data := v_data || jsonb_build_object('notes', v_notes, 'conversations', v_conversations);
  if v_data ? 'organizationJobs' then
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb) into v_jobs
      from jsonb_array_elements(conuo_private.json_array(v_data->'organizationJobs')) with ordinality item(value,ordinality)
      where not conuo_private.content_references_selected_notes(item.value, p_note_ids);
    v_data := jsonb_set(v_data, '{organizationJobs}', v_jobs);
  end if;
  if v_data ? 'conceptRelations' then
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb) into v_relations
      from jsonb_array_elements(conuo_private.json_array(v_data->'conceptRelations')) with ordinality item(value,ordinality)
      where not (item.value->>'origin' = 'ai' and conuo_private.relation_references_selected_notes(item.value, p_note_ids));
    v_data := jsonb_set(v_data, '{conceptRelations}', v_relations);
  end if;
  return v_data;
end;
$$;

alter function conuo_private.source_purge_preview(uuid,text)
  rename to source_purge_preview_before_content_selection;
create function conuo_private.source_purge_selection_preview(
  p_owner uuid, p_source_id text, p_note_ids text[], p_conversation_ids text[]
) returns jsonb language plpgsql set search_path = '' as $$
declare
  v_workspace public.workspaces%rowtype; v_base jsonb; v_notes jsonb; v_conversations jsonb;
  v_jobs jsonb; v_private_jobs jsonb; v_relations jsonb; v_annotations jsonb; v_source jsonb; v_import_jobs jsonb;
  v_note_ids text[]; v_conversation_ids text[]; v_selection jsonb; v_content_selection jsonb;
  v_impact jsonb; v_blockers jsonb; v_manual_relations jsonb; v_fingerprint text;
  v_retained_notes integer; v_note_refs integer; v_retained_conversations integer; v_conversation_refs integer;
  v_removed_versions integer; v_removed_messages integer;
begin
  perform conuo_private.assert_account_access(p_owner);
  if p_note_ids is null or p_conversation_ids is null
    or coalesce(array_ndims(p_note_ids),1) <> 1 or coalesce(array_ndims(p_conversation_ids),1) <> 1
    or cardinality(p_note_ids) > 10000 or cardinality(p_conversation_ids) > 5000
    or exists (select 1 from unnest(p_note_ids || p_conversation_ids) id(value)
      where id.value is null or not conuo_private.valid_id(id.value))
    or cardinality(p_note_ids) <> (select count(distinct value) from unnest(p_note_ids) id(value))
    or cardinality(p_conversation_ids) <> (select count(distinct value) from unnest(p_conversation_ids) id(value)) then
    raise exception using errcode = '22023', message = 'Invalid saved content purge selection';
  end if;
  select coalesce(array_agg(value order by value collate "C"),'{}') into v_note_ids from unnest(p_note_ids) id(value);
  select coalesce(array_agg(value order by value collate "C"),'{}') into v_conversation_ids from unnest(p_conversation_ids) id(value);
  v_base := conuo_private.source_purge_preview_before_content_selection(p_owner, p_source_id);
  select * into v_workspace from public.workspaces where owner_id = p_owner;
  if not found or v_workspace.revision <> (v_base->>'revision')::bigint then
    raise exception using errcode = '40001', message = 'Source purge impact changed';
  end if;
  select coalesce(jsonb_agg(item.value order by item.value->>'id'), '[]'::jsonb) into v_notes
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'notes')) item(value)
    where conuo_private.note_source_reference_count(item.value, p_source_id) > 0;
  select coalesce(jsonb_agg(item.value order by item.value->>'id'), '[]'::jsonb) into v_conversations
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'conversations')) item(value)
    where conuo_private.conversation_references_purged_source(item.value, p_source_id);
  if exists (select 1 from unnest(v_note_ids) id(value) where not exists
      (select 1 from jsonb_array_elements(v_notes) item(value) where item.value->>'id' = id.value))
    or exists (select 1 from unnest(v_conversation_ids) id(value) where not exists
      (select 1 from jsonb_array_elements(v_conversations) item(value) where item.value->>'id' = id.value)) then
    raise exception using errcode = '22023', message = 'Saved content purge selection is unavailable';
  end if;
  v_selection := jsonb_build_object('noteIds', to_jsonb(v_note_ids), 'conversationIds', to_jsonb(v_conversation_ids));
  v_content_selection := jsonb_build_object('version', 1, 'selection', v_selection,
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id',item.value->>'id','title',item.value->>'title',
      'kind',item.value->>'kind','versions',1+jsonb_array_length(conuo_private.json_array(item.value->'versions'))) order by item.value->>'id')
      from jsonb_array_elements(v_notes) item(value)), '[]'::jsonb),
    'conversations', coalesce((select jsonb_agg(jsonb_build_object('id',item.value->>'id','title',item.value->>'title',
      'messages',jsonb_array_length(conuo_private.json_array(item.value->'messages'))) order by item.value->>'id')
      from jsonb_array_elements(v_conversations) item(value)), '[]'::jsonb));
  select count(*) filter (where not (item.value->>'id' = any(v_note_ids)))::integer,
    coalesce(sum(conuo_private.note_source_reference_count(item.value,p_source_id)) filter (where not (item.value->>'id' = any(v_note_ids))),0)::integer,
    coalesce(sum(1+jsonb_array_length(conuo_private.json_array(item.value->'versions'))) filter (where item.value->>'id' = any(v_note_ids)),0)::integer
    into v_retained_notes,v_note_refs,v_removed_versions from jsonb_array_elements(v_notes) item(value);
  select count(*) filter (where not (item.value->>'id' = any(v_conversation_ids)))::integer,
    coalesce(sum(conuo_private.conversation_source_reference_count(item.value,p_source_id)) filter (where not (item.value->>'id' = any(v_conversation_ids))),0)::integer,
    coalesce(sum(jsonb_array_length(conuo_private.json_array(item.value->'messages'))) filter (where item.value->>'id' = any(v_conversation_ids)),0)::integer
    into v_retained_conversations,v_conversation_refs,v_removed_messages from jsonb_array_elements(v_conversations) item(value);
  select coalesce(jsonb_agg(item.value order by item.value->>'id'),'[]'::jsonb) into v_jobs
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'organizationJobs')) item(value)
    where conuo_private.organization_job_references_purged_source(item.value,p_source_id)
      or conuo_private.content_references_selected_notes(item.value,v_note_ids);
  -- Include staged server-owned content in confirmation, not lease heartbeat
  -- timestamps. A staged result/state change needs a fresh preview even before
  -- publication changes the workspace revision; identical IDs are counted once.
  select coalesce(jsonb_agg(jsonb_build_object('id',job.job_id,'state',job.state,
    'request',job.request,'requestDigest',job.request_digest,'contextDigest',job.context_digest,
    'result',job.result,'resultDigest',job.result_digest,'modelRequestId',job.model_request_id,
    'attempt',job.attempt,'publishedRevision',job.published_revision) order by job.job_id),'[]'::jsonb)
    into v_private_jobs from conuo_private.organization_jobs job where job.owner_id=p_owner
    and conuo_private.organization_task_references_purge(to_jsonb(job),v_workspace.data->'organizationJobs',p_source_id,v_note_ids);
  select coalesce(jsonb_agg(item.value order by item.value->>'id'),'[]'::jsonb) into v_relations
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'conceptRelations')) item(value)
    where conuo_private.relation_references_purged_source(item.value,p_source_id)
      or conuo_private.relation_references_selected_notes(item.value,v_note_ids);
  select coalesce(jsonb_agg(to_jsonb(item.value->>'id') order by item.value->>'id'),'[]'::jsonb) into v_manual_relations
    from jsonb_array_elements(v_relations) item(value) where item.value->>'origin' = 'manual';
  select coalesce(jsonb_agg(item.value order by item.value->>'id'),'[]'::jsonb) into v_annotations
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'annotations')) item(value) where item.value->>'sourceId' = p_source_id;
  select item.value into v_source from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'sources')) item(value) where item.value->>'id' = p_source_id;
  select coalesce(jsonb_agg(item.value order by item.value->>'id'),'[]'::jsonb) into v_import_jobs
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'importJobs')) item(value) where item.value->>'sourceId' = p_source_id;
  v_impact := (v_base->'impact') || jsonb_build_object(
    'retainedNotes',v_retained_notes,'retainedNoteCitations',v_note_refs,'notes',v_retained_notes,'noteCitations',v_note_refs,
    'retainedConversations',v_retained_conversations,'retainedConversationCitations',v_conversation_refs,'conversations',v_retained_conversations,'conversationCitations',v_conversation_refs,
    'removedNotes',cardinality(v_note_ids),'removedNoteVersions',v_removed_versions,
    'removedConversations',cardinality(v_conversation_ids),'removedMessages',v_removed_messages,
    'organizationJobs',(select count(distinct item.value->>'id') from jsonb_array_elements(v_jobs || v_private_jobs) item(value)),
    'pendingOrganizationJobs',(select count(distinct item.value->>'id') from jsonb_array_elements(v_jobs || v_private_jobs) item(value)
      where item.value->>'status' in ('queued','running') or item.value->>'state' in ('queued','running')),
    'conceptRelations',(select count(*) from jsonb_array_elements(v_relations) item(value) where item.value->>'origin' = 'ai'),
    'aiRelations',(select count(*) from jsonb_array_elements(v_relations) item(value) where item.value->>'origin' = 'ai'),
    'blockingConceptRelations',jsonb_array_length(v_manual_relations));
  v_blockers := (v_base->'blockers') || jsonb_build_object('conceptRelations',v_manual_relations);
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object('ownerId',p_owner,'baseFingerprint',v_base->>'fingerprint',
    'contentSelection',v_content_selection,'impact',v_impact,'blockers',v_blockers,'source',v_source,
    'notes',v_notes,'conversations',v_conversations,'annotations',v_annotations,
    'organizationJobs',v_jobs,'privateOrganizationJobs',v_private_jobs,'conceptRelations',v_relations,'importJobs',v_import_jobs)::text,'UTF8')),'hex');
  return jsonb_build_object('revision',v_workspace.revision,'fingerprint',v_fingerprint,
    'impact',v_impact,'blockers',v_blockers,'contentSelection',v_content_selection);
end;
$$;

create function conuo_private.source_purge_preview(p_owner uuid, p_source_id text)
returns jsonb language sql set search_path = '' as $$
  select conuo_private.source_purge_selection_preview(p_owner,p_source_id,'{}'::text[],'{}'::text[]);
$$;
create function public.preview_source_purge_selection(p_source_id text,p_note_ids text[],p_conversation_ids text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception using errcode='42501',message='Authentication required'; end if;
  return conuo_private.source_purge_selection_preview(v_owner,p_source_id,p_note_ids,p_conversation_ids);
end;
$$;
create or replace function public.preview_source_purge(p_source_id text)
returns jsonb language sql security definer set search_path = '' as $$
  select public.preview_source_purge_selection(p_source_id,'{}'::text[],'{}'::text[]);
$$;

create function public.request_source_purge_selection(
  p_source_id text,p_expected_revision bigint,p_fingerprint text,p_note_ids text[],p_conversation_ids text[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid(); v_workspace public.workspaces%rowtype; v_preview jsonb; v_data jsonb;
  v_purge_id uuid := gen_random_uuid(); v_revision bigint; v_cleanup_pending boolean;
  v_note_ids text[]; v_conversation_ids text[]; v_cache_request_ids text[];
begin
  if v_owner is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if not conuo_private.valid_id(p_source_id) or p_expected_revision is null or p_expected_revision < 1
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='Invalid source purge confirmation';
  end if;
  perform conuo_private.owner_lock(v_owner);
  select * into v_workspace from public.workspaces where owner_id=v_owner for update;
  if not found then raise exception using errcode='22023',message='Source unavailable for permanent deletion'; end if;
  if v_workspace.revision <> p_expected_revision then raise exception using errcode='40001',message='Workspace revision conflict'; end if;
  v_preview := conuo_private.source_purge_selection_preview(v_owner,p_source_id,p_note_ids,p_conversation_ids);
  if v_preview->>'fingerprint' <> p_fingerprint then raise exception using errcode='40001',message='Source purge impact changed'; end if;
  if jsonb_array_length(v_preview->'blockers'->'annotations') > 0 or jsonb_array_length(v_preview->'blockers'->'conceptRelations') > 0 then
    raise exception using errcode='P0001',message='Saved annotations or manual relations must be resolved before permanent deletion';
  end if;
  select coalesce(array_agg(value),'{}') into v_note_ids from jsonb_array_elements_text(v_preview#>'{contentSelection,selection,noteIds}') id(value);
  select coalesce(array_agg(value),'{}') into v_conversation_ids from jsonb_array_elements_text(v_preview#>'{contentSelection,selection,conversationIds}') id(value);
  -- Capture exact request identities before deleting their authoritative records.
  -- A selected conversation can contain a later answer about an unrelated source:
  -- all its historical attempt IDs belong to the explicitly selected deletion.
  select coalesce(array_agg(distinct refs.value order by refs.value),'{}') into v_cache_request_ids from (
    select message.value #>> '{attempt,id}' as value
      from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'conversations')) conversation(value)
      cross join lateral jsonb_array_elements(conuo_private.json_array(conversation.value->'messages')) message(value)
      where conversation.value->>'id' = any(v_conversation_ids)
    union all
    select job.value #>> '{request,requestId}' as value
      from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'organizationJobs')) job(value)
      where conuo_private.organization_job_references_purged_source(job.value,p_source_id)
        or conuo_private.content_references_selected_notes(job.value,v_note_ids)
    union all
    select job.model_request_id as value from conuo_private.organization_jobs job
      where job.owner_id=v_owner and conuo_private.organization_task_references_purge(
        to_jsonb(job),v_workspace.data->'organizationJobs',p_source_id,v_note_ids)
  ) refs where conuo_private.valid_id(refs.value);
  v_data := conuo_private.sanitize_source_purge_selection(v_workspace.data,p_source_id,v_note_ids,v_conversation_ids);
  v_cleanup_pending := (v_preview->'impact'->>'storageObjects')::integer > 0;
  insert into public.source_purges(purge_id,owner_id,source_id,workspace_revision,state,completed_at)
    values(v_purge_id,v_owner,p_source_id,v_workspace.revision+1,
      case when v_cleanup_pending then 'pending' else 'completed' end,case when v_cleanup_pending then null else now() end);
  insert into public.source_purge_objects(purge_id,storage_path)
    select v_purge_id,version.storage_path from public.source_versions version
    where version.owner_id=v_owner and version.source_id=p_source_id and version.storage_path is not null;
  insert into public.source_tombstones(owner_id,source_id,purge_id,workspace_revision)
    values(v_owner,p_source_id,v_purge_id,v_workspace.revision+1);
  insert into conuo_private.saved_content_tombstones(owner_id,kind,content_id,purge_id,workspace_revision)
    select v_owner,'note',id.value,v_purge_id,v_workspace.revision+1 from unnest(v_note_ids) id(value)
    union all select v_owner,'conversation',id.value,v_purge_id,v_workspace.revision+1 from unnest(v_conversation_ids) id(value);
  -- Remove all states of the durable job, including staged completed results.
  -- The existing workspace trigger separately fences active source-only jobs.
  delete from conuo_private.organization_jobs job where job.owner_id=v_owner
    and conuo_private.organization_task_references_purge(to_jsonb(job),v_workspace.data->'organizationJobs',p_source_id,v_note_ids);
  update public.workspaces set data=v_data,revision=revision+1,updated_at=now()
    where owner_id=v_owner and revision=v_workspace.revision returning revision into v_revision;
  if v_revision is null then raise exception using errcode='40001',message='Workspace revision conflict'; end if;
  perform conuo_private.project_workspace(v_owner,v_data);
  -- Keep ledger rows and their original timestamps/fingerprints for usage and
  -- idempotency. Completed unrelated results remain usable. Running reservations
  -- still have no source/saved-content provenance, so retain the existing owner-
  -- wide running fence: finish_ai_request cannot later complete a failed row.
  update public.ai_requests request set state='failed',result=null,error_code='SOURCE_PURGED',updated_at=now()
    where request.owner_id=v_owner and (request.state='running' or (request.result is not null and (
      request.request_id = any(v_cache_request_ids)
      or conuo_private.content_references_purged_source(request.result,p_source_id)
      or conuo_private.content_references_selected_notes(request.result,v_note_ids))));
  delete from public.sources where owner_id=v_owner and source_id=p_source_id;
  return jsonb_build_object('revision',v_revision,'data',v_data,'purgeId',v_purge_id,'cleanupPending',v_cleanup_pending);
end;
$$;
create or replace function public.request_source_purge(p_source_id text,p_expected_revision bigint,p_fingerprint text)
returns jsonb language sql security definer set search_path = '' as $$
  select public.request_source_purge_selection(p_source_id,p_expected_revision,p_fingerprint,'{}'::text[],'{}'::text[]);
$$;

revoke all on function conuo_private.fence_saved_content_on_workspace_write(),
  conuo_private.note_source_reference_count(jsonb,text),conuo_private.scope_references_purged_source(jsonb,text),
  conuo_private.conversation_source_reference_count(jsonb,text),conuo_private.conversation_references_purged_source(jsonb,text),
  conuo_private.content_references_selected_notes(jsonb,text[]),conuo_private.relation_references_selected_notes(jsonb,text[]),
  conuo_private.content_references_purged_source(jsonb,text),conuo_private.organization_task_references_purge(jsonb,jsonb,text,text[]),
  conuo_private.sanitize_purged_source_workspace(jsonb,text),conuo_private.sanitize_source_purge_selection(jsonb,text,text[],text[]),
  conuo_private.source_purge_selection_preview(uuid,text,text[],text[]),conuo_private.source_purge_preview(uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function public.preview_source_purge_selection(text,text[],text[]),
  public.request_source_purge_selection(text,bigint,text,text[],text[]),
  public.preview_source_purge(text),public.request_source_purge(text,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.preview_source_purge_selection(text,text[],text[]),
  public.request_source_purge_selection(text,bigint,text,text[],text[]),
  public.preview_source_purge(text),public.request_source_purge(text,bigint,text)
  to authenticated;

commit;
