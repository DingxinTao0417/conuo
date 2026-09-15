-- Irreversible source purges. Metadata is committed atomically; a separate privileged
-- Storage worker must later drain source_purge_objects. A pending outbox row is never
-- evidence that an original was physically deleted.
begin;

create table public.source_tombstones (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  source_id text not null check (source_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  purge_id uuid not null,
  workspace_revision bigint not null check (workspace_revision > 0),
  purged_at timestamptz not null default now(),
  primary key (owner_id, source_id),
  unique (purge_id)
);

create table public.source_purges (
  purge_id uuid primary key,
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  source_id text not null check (source_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  workspace_revision bigint not null check (workspace_revision > 0),
  requested_at timestamptz not null default now(),
  -- Purges without an original path complete atomically; all other terminal states
  -- are written only by a future server-side Storage worker.
  state text not null default 'pending' check (state in ('pending', 'processing', 'completed', 'failed')),
  completed_at timestamptz,
  last_error text
);
create unique index source_purges_owner_source on public.source_purges(owner_id, source_id);

create table public.source_purge_objects (
  purge_id uuid not null references public.source_purges(purge_id) on delete cascade,
  storage_path text not null,
  state text not null default 'pending' check (state in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (purge_id, storage_path)
);
create index source_purge_objects_dispatch on public.source_purge_objects(state, created_at)
  where state in ('pending', 'processing', 'failed');

do $$
declare t text;
begin
  foreach t in array array['source_tombstones', 'source_purges', 'source_purge_objects'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

-- Treat malformed optional arrays as empty in the purge helpers. The workspace writer
-- validates normal payloads; these guards make a destructive operation fail closed on
-- references rather than attempting to interpret arbitrary JSON as evidence.
create function conuo_private.json_array(p_value jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_value) = 'array' then p_value else '[]'::jsonb end;
$$;

create function conuo_private.purge_citations(p_citations jsonb, p_source_id text) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(c.value order by c.ordinality), '[]'::jsonb)
  from jsonb_array_elements(conuo_private.json_array(p_citations)) with ordinality as c(value, ordinality)
  where c.value->>'sourceId' is distinct from p_source_id;
$$;

create function conuo_private.purge_citation_count(p_citations jsonb, p_source_id text) returns integer
language sql immutable set search_path = '' as $$
  select count(*)::integer
  from jsonb_array_elements(conuo_private.json_array(p_citations)) as c(value)
  where c.value->>'sourceId' = p_source_id;
$$;

create function conuo_private.relation_references_purged_source(p_relation jsonb, p_source_id text)
returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1
    from (
      select value from jsonb_array_elements(conuo_private.json_array(p_relation->'fromCitations'))
      union all
      select value from jsonb_array_elements(conuo_private.json_array(p_relation->'toCitations'))
      union all
      select value from jsonb_array_elements(conuo_private.json_array(p_relation#>'{from,citations}'))
      union all
      select value from jsonb_array_elements(conuo_private.json_array(p_relation#>'{to,citations}'))
    ) as citation(value)
    where citation.value->>'sourceId' = p_source_id
  );
$$;

create function conuo_private.organization_job_references_purged_source(p_job jsonb, p_source_id text)
returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1
    from jsonb_array_elements_text(conuo_private.json_array(p_job#>'{request,sourceIds}')) as source_id(value)
    where source_id.value = p_source_id
  ) or exists (
    select 1
    from jsonb_array_elements(conuo_private.json_array(p_job#>'{request,sourceVersions}')) as version(value)
    where version.value->>'sourceId' = p_source_id
  );
$$;

-- Remove only source references from independently saved notes and conversations.
-- Their authored bodies remain unchanged. System-derived work is removed elsewhere.
create function conuo_private.sanitize_purged_source_workspace(p_data jsonb, p_source_id text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_sources jsonb;
  v_annotations jsonb;
  v_notes jsonb;
  v_conversations jsonb;
  v_import_jobs jsonb;
  v_organization_jobs jsonb;
  v_relations jsonb;
begin
  select coalesce(jsonb_agg(source.value order by source.ordinality), '[]'::jsonb)
    into v_sources
    from jsonb_array_elements(conuo_private.json_array(p_data->'sources')) with ordinality as source(value, ordinality)
    where source.value->>'id' is distinct from p_source_id;

  select coalesce(jsonb_agg(annotation.value order by annotation.ordinality), '[]'::jsonb)
    into v_annotations
    from jsonb_array_elements(conuo_private.json_array(p_data->'annotations')) with ordinality as annotation(value, ordinality)
    where annotation.value->>'sourceId' is distinct from p_source_id;

  select coalesce(
    jsonb_agg(
      (note.value - 'citations' - 'versions') || jsonb_build_object(
        'citations', conuo_private.purge_citations(note.value->'citations', p_source_id),
        'versions', coalesce((
          select jsonb_agg(
            (version.value - 'citations') || jsonb_build_object(
              'citations', conuo_private.purge_citations(version.value->'citations', p_source_id)
            ) order by version.ordinality
          )
          from jsonb_array_elements(conuo_private.json_array(note.value->'versions')) with ordinality as version(value, ordinality)
        ), '[]'::jsonb)
      ) order by note.ordinality
    ), '[]'::jsonb)
    into v_notes
    from jsonb_array_elements(conuo_private.json_array(p_data->'notes')) with ordinality as note(value, ordinality);

  select coalesce(
    jsonb_agg(
      (conversation.value - 'sourceId' - 'sourceIds' - 'messages' - 'scope') ||
      case
        when conversation.value ? 'sourceId' and conversation.value->>'sourceId' is distinct from p_source_id
          then jsonb_build_object('sourceId', conversation.value->'sourceId')
        else '{}'::jsonb
      end ||
      case
        when conversation.value->>'sourceId' = p_source_id and conversation.value->>'scope' = 'document'
          then jsonb_build_object('scope', 'sources')
        when conversation.value ? 'scope' then jsonb_build_object('scope', conversation.value->'scope')
        else '{}'::jsonb
      end || jsonb_build_object(
        'sourceIds', coalesce((
          select jsonb_agg(source_id.value order by source_id.ordinality)
          from jsonb_array_elements(conuo_private.json_array(conversation.value->'sourceIds')) with ordinality as source_id(value, ordinality)
          where source_id.value #>> '{}' is distinct from p_source_id
        ), '[]'::jsonb),
        'messages', coalesce((
          select jsonb_agg(
            (message.value - 'citations') || jsonb_build_object(
              'citations', conuo_private.purge_citations(message.value->'citations', p_source_id)
            ) order by message.ordinality
          )
          from jsonb_array_elements(conuo_private.json_array(conversation.value->'messages')) with ordinality as message(value, ordinality)
        ), '[]'::jsonb)
      ) order by conversation.ordinality
    ), '[]'::jsonb)
    into v_conversations
    from jsonb_array_elements(conuo_private.json_array(p_data->'conversations')) with ordinality as conversation(value, ordinality);

  if p_data ? 'importJobs' then
    select coalesce(jsonb_agg(job.value order by job.ordinality), '[]'::jsonb)
      into v_import_jobs
      from jsonb_array_elements(conuo_private.json_array(p_data->'importJobs')) with ordinality as job(value, ordinality)
      where job.value->>'sourceId' is distinct from p_source_id;
  end if;

  if p_data ? 'organizationJobs' then
    select coalesce(jsonb_agg(job.value order by job.ordinality), '[]'::jsonb)
      into v_organization_jobs
      from jsonb_array_elements(conuo_private.json_array(p_data->'organizationJobs')) with ordinality as job(value, ordinality)
      where not conuo_private.organization_job_references_purged_source(job.value, p_source_id);
  end if;

  if p_data ? 'conceptRelations' then
    select coalesce(jsonb_agg(relation.value order by relation.ordinality), '[]'::jsonb)
      into v_relations
      from jsonb_array_elements(conuo_private.json_array(p_data->'conceptRelations')) with ordinality as relation(value, ordinality)
      where not (
        relation.value->>'origin' = 'ai'
        and conuo_private.relation_references_purged_source(relation.value, p_source_id)
      );
  end if;

  return (p_data - 'sources' - 'annotations' - 'notes' - 'conversations' - 'importJobs' - 'organizationJobs' - 'conceptRelations') ||
    jsonb_build_object(
      'sources', v_sources,
      'annotations', v_annotations,
      'notes', v_notes,
      'conversations', v_conversations
    ) ||
    case when p_data ? 'importJobs' then jsonb_build_object('importJobs', v_import_jobs) else '{}'::jsonb end ||
    case when p_data ? 'organizationJobs' then jsonb_build_object('organizationJobs', v_organization_jobs) else '{}'::jsonb end ||
    case when p_data ? 'conceptRelations' then jsonb_build_object('conceptRelations', v_relations) else '{}'::jsonb end;
end;
$$;

-- The confirmation fingerprint is derived entirely from the current cloud snapshot and
-- canonical source manifest. Clients cannot choose storage paths or impact counts.
create function conuo_private.source_purge_preview(p_owner uuid, p_source_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_workspace public.workspaces%rowtype;
  v_source public.sources%rowtype;
  v_deleted_at text;
  v_versions jsonb := '[]'::jsonb;
  v_paths jsonb := '[]'::jsonb;
  v_blob_keys jsonb := '[]'::jsonb;
  v_annotations jsonb := '[]'::jsonb;
  v_annotation_blockers jsonb := '[]'::jsonb;
  v_notes jsonb := '[]'::jsonb;
  v_conversations jsonb := '[]'::jsonb;
  v_organization_jobs jsonb := '[]'::jsonb;
  v_ai_relations jsonb := '[]'::jsonb;
  v_manual_relations jsonb := '[]'::jsonb;
  v_import_jobs jsonb := '[]'::jsonb;
  v_chunks integer := 0;
  v_embedding_jobs integer := 0;
  v_embeddings integer := 0;
  v_note_citations integer := 0;
  v_conversation_citations integer := 0;
  v_pending_organization_jobs integer := 0;
  v_impact jsonb;
  v_blockers jsonb;
  v_fingerprint text;
begin
  if p_owner is null or not conuo_private.valid_id(p_source_id) then
    raise exception using errcode = '22023', message = 'Invalid source purge request';
  end if;
  select * into v_workspace from public.workspaces where owner_id = p_owner;
  if not found then
    raise exception using errcode = '22023', message = 'Source unavailable for permanent deletion';
  end if;
  select * into v_source from public.sources where owner_id = p_owner and source_id = p_source_id;
  if not found or v_source.deleted_at is null or not exists (
    select 1
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'sources')) as source(value)
    where source.value->>'id' = p_source_id and source.value->>'deletedAt' is not null
  ) then
    raise exception using errcode = '22023', message = 'Source unavailable for permanent deletion';
  end if;
  -- Fingerprints must not depend on a caller's PostgreSQL TimeZone setting.
  v_deleted_at := to_char(
    v_source.deleted_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'versionId', version.version_id,
    'contentDigest', version.content_digest,
    'storagePath', version.storage_path,
    'retained', version.retained
  ) order by version.version_id), '[]'::jsonb),
  coalesce(jsonb_agg(to_jsonb(version.storage_path) order by version.storage_path)
    filter (where version.storage_path is not null), '[]'::jsonb),
  coalesce(jsonb_agg(to_jsonb(version.blob_key) order by version.blob_key)
    filter (where version.blob_key is not null), '[]'::jsonb)
    into v_versions, v_paths, v_blob_keys
    from public.source_versions version
    where version.owner_id = p_owner and version.source_id = p_source_id;

  select count(*)::integer into v_chunks
    from public.source_chunks where owner_id = p_owner and source_id = p_source_id;
  select count(*)::integer into v_embedding_jobs
    from public.embedding_jobs where owner_id = p_owner and source_id = p_source_id;
  select count(*)::integer into v_embeddings
    from public.chunk_embeddings where owner_id = p_owner and source_id = p_source_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', annotation.value->>'id',
    'versionId', annotation.value->>'versionId',
    'hasSavedNote', length(btrim(coalesce(annotation.value->>'note', ''))) > 0
  ) order by annotation.value->>'id'), '[]'::jsonb),
  coalesce(jsonb_agg(to_jsonb(annotation.value->>'id') order by annotation.value->>'id')
    filter (where length(btrim(coalesce(annotation.value->>'note', ''))) > 0), '[]'::jsonb)
    into v_annotations, v_annotation_blockers
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'annotations')) as annotation(value)
    where annotation.value->>'sourceId' = p_source_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', refs.note->>'id', 'citations', refs.citations)
    order by refs.note->>'id'), '[]'::jsonb),
    coalesce(sum(refs.citations), 0)::integer
    into v_notes, v_note_citations
    from (
      select note.value as note,
        conuo_private.purge_citation_count(note.value->'citations', p_source_id) + coalesce((
          select sum(conuo_private.purge_citation_count(version.value->'citations', p_source_id))::integer
          from jsonb_array_elements(conuo_private.json_array(note.value->'versions')) as version(value)
        ), 0) as citations
      from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'notes')) as note(value)
    ) as refs
    where refs.citations > 0;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', refs.conversation->>'id',
    'directReference', refs.direct_reference,
    'citations', refs.citations
  ) order by refs.conversation->>'id'), '[]'::jsonb),
    coalesce(sum(refs.citations), 0)::integer
    into v_conversations, v_conversation_citations
    from (
      select conversation.value as conversation,
        (conversation.value->>'sourceId' = p_source_id or exists (
          select 1
          from jsonb_array_elements_text(conuo_private.json_array(conversation.value->'sourceIds')) as source_id(value)
          where source_id.value = p_source_id
        )) as direct_reference,
        coalesce((
          select sum(conuo_private.purge_citation_count(message.value->'citations', p_source_id))::integer
          from jsonb_array_elements(conuo_private.json_array(conversation.value->'messages')) as message(value)
        ), 0) as citations
      from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'conversations')) as conversation(value)
    ) as refs
    where refs.direct_reference or refs.citations > 0;

  select coalesce(jsonb_agg(jsonb_build_object('id', job.value->>'id', 'status', job.value->>'status')
    order by job.value->>'id'), '[]'::jsonb)
    into v_organization_jobs
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'organizationJobs')) as job(value)
    where conuo_private.organization_job_references_purged_source(job.value, p_source_id);
  select count(*)::integer into v_pending_organization_jobs
    from jsonb_array_elements(v_organization_jobs) as job(value)
    where job.value->>'status' in ('queued', 'running');

  select coalesce(jsonb_agg(to_jsonb(relation.value->>'id') order by relation.value->>'id')
    filter (where relation.value->>'origin' = 'ai'), '[]'::jsonb),
  coalesce(jsonb_agg(to_jsonb(relation.value->>'id') order by relation.value->>'id')
    filter (where relation.value->>'origin' = 'manual'), '[]'::jsonb)
    into v_ai_relations, v_manual_relations
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'conceptRelations')) as relation(value)
    where conuo_private.relation_references_purged_source(relation.value, p_source_id);

  select coalesce(jsonb_agg(jsonb_build_object('id', job.value->>'id', 'versionId', job.value->>'versionId',
    'status', job.value->>'status') order by job.value->>'id'), '[]'::jsonb)
    into v_import_jobs
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'importJobs')) as job(value)
    where job.value->>'sourceId' = p_source_id;

  v_impact := jsonb_build_object(
    'source', jsonb_build_object(
      'id', v_source.source_id,
      'title', v_source.title,
      'deletedAt', v_deleted_at
    ),
    'versions', jsonb_array_length(v_versions),
    'annotations', jsonb_array_length(v_annotations) - jsonb_array_length(v_annotation_blockers),
    'blockingAnnotations', jsonb_array_length(v_annotation_blockers),
    'retainedNotes', jsonb_array_length(v_notes),
    'retainedNoteCitations', v_note_citations,
    'retainedConversations', jsonb_array_length(v_conversations),
    'retainedConversationCitations', v_conversation_citations,
    'organizationJobs', jsonb_array_length(v_organization_jobs),
    'pendingOrganizationJobs', v_pending_organization_jobs,
    'conceptRelations', jsonb_array_length(v_ai_relations),
    'blockingConceptRelations', jsonb_array_length(v_manual_relations),
    'importJobs', jsonb_array_length(v_import_jobs),
    'localOriginals', jsonb_array_length(v_blob_keys),
    'cloudOriginals', jsonb_array_length(v_paths),
    'chunks', v_chunks,
    'embeddingJobs', v_embedding_jobs,
    'embeddings', v_embeddings,
    'storageObjects', jsonb_array_length(v_paths),
    'notes', jsonb_array_length(v_notes),
    'noteCitations', v_note_citations,
    'conversations', jsonb_array_length(v_conversations),
    'conversationCitations', v_conversation_citations,
    'aiRelations', jsonb_array_length(v_ai_relations),
    'derivedImportJobs', jsonb_array_length(v_import_jobs)
  );
  v_blockers := jsonb_build_object(
    'annotations', v_annotation_blockers,
    'conceptRelations', v_manual_relations
  );
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'revision', v_workspace.revision,
    'source', jsonb_build_object(
      'id', v_source.source_id,
      'versionId', v_source.current_version_id,
      'deletedAt', v_deleted_at,
      'versions', v_versions,
      'blobKeys', v_blob_keys,
      'storagePaths', v_paths
    ),
    'impact', v_impact,
    'blockers', v_blockers,
    'annotations', v_annotations,
    'notes', v_notes,
    'conversations', v_conversations,
    'organizationJobs', v_organization_jobs,
    'aiRelations', v_ai_relations,
    'importJobs', v_import_jobs
  )::text, 'UTF8')), 'hex');
  return jsonb_build_object(
    'revision', v_workspace.revision,
    'fingerprint', v_fingerprint,
    'impact', v_impact,
    'blockers', v_blockers
  );
end;
$$;

create function public.preview_source_purge(p_source_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  return conuo_private.source_purge_preview(v_owner, p_source_id);
end;
$$;

create function public.request_source_purge(
  p_source_id text,
  p_expected_revision bigint,
  p_fingerprint text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_preview jsonb;
  v_data jsonb;
  v_purge_id uuid := gen_random_uuid();
  v_revision bigint;
  v_path text;
  v_cleanup_pending boolean;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not conuo_private.valid_id(p_source_id)
    or p_expected_revision is null or p_expected_revision < 1
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid source purge confirmation';
  end if;

  perform conuo_private.owner_lock(v_owner);
  select * into v_workspace from public.workspaces where owner_id = v_owner for update;
  if not found then
    raise exception using errcode = '22023', message = 'Source unavailable for permanent deletion';
  end if;
  if v_workspace.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;

  v_preview := conuo_private.source_purge_preview(v_owner, p_source_id);
  if v_preview->>'fingerprint' <> p_fingerprint then
    raise exception using errcode = '40001', message = 'Source purge impact changed';
  end if;
  if jsonb_array_length(v_preview->'blockers'->'annotations') > 0
    or jsonb_array_length(v_preview->'blockers'->'conceptRelations') > 0 then
    raise exception using errcode = 'P0001', message = 'Saved annotations or manual relations must be resolved before permanent deletion';
  end if;

  v_data := conuo_private.sanitize_purged_source_workspace(v_workspace.data, p_source_id);
  v_cleanup_pending := (v_preview->'impact'->>'storageObjects')::integer > 0;
  insert into public.source_purges(purge_id, owner_id, source_id, workspace_revision, state, completed_at)
    values (
      v_purge_id,
      v_owner,
      p_source_id,
      v_workspace.revision + 1,
      case when v_cleanup_pending then 'pending' else 'completed' end,
      case when v_cleanup_pending then null else now() end
    );
  insert into public.source_purge_objects(purge_id, storage_path)
    select v_purge_id, version.storage_path
    from public.source_versions version
    where version.owner_id = v_owner and version.source_id = p_source_id
      and version.storage_path is not null;
  insert into public.source_tombstones(owner_id, source_id, purge_id, workspace_revision)
    values (v_owner, p_source_id, v_purge_id, v_workspace.revision + 1);

  update public.workspaces
    set data = v_data, revision = revision + 1, updated_at = now()
    where owner_id = v_owner and revision = v_workspace.revision
    returning revision into v_revision;
  if v_revision is null then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  perform conuo_private.project_workspace(v_owner, v_data);
  -- Cached or in-flight AI results do not carry per-source provenance in this schema.
  -- Invalidate the owner's ledger so a late completion cannot retain purged evidence.
  update public.ai_requests set state = 'failed', result = null, error_code = 'SOURCE_PURGED', updated_at = now()
    where owner_id = v_owner and (state = 'running' or result is not null);
  delete from public.sources where owner_id = v_owner and source_id = p_source_id;

  return jsonb_build_object(
    'revision', v_revision,
    'data', v_data,
    'purgeId', v_purge_id,
    'cleanupPending', v_cleanup_pending
  );
end;
$$;

-- All normal workspace saves must reject a tombstoned ID before updating the snapshot.
-- This closes the stale-tab / retry path that would otherwise recreate canonical source rows.
create or replace function public.save_workspace(p_data jsonb, p_expected_revision bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_revision bigint;
begin
  if v_owner is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_expected_revision is null or p_expected_revision<0 or p_data is null
    or jsonb_typeof(p_data)<>'object' or p_data->>'schemaVersion' is distinct from '1'
    or jsonb_typeof(p_data->'spaces') is distinct from 'array'
    or jsonb_typeof(p_data->'sources') is distinct from 'array'
    or jsonb_typeof(p_data->'notes') is distinct from 'array'
    or jsonb_typeof(p_data->'annotations') is distinct from 'array'
    or jsonb_typeof(p_data->'conversations') is distinct from 'array'
    or jsonb_typeof(p_data->'aiEnabled') is distinct from 'boolean'
    or octet_length(p_data::text)>3145728 then
    raise exception using errcode='22023', message='Invalid workspace payload';
  end if;
  perform conuo_private.owner_lock(v_owner);
  if exists (
    select 1
    from jsonb_array_elements(conuo_private.json_array(p_data->'sources')) as source(value)
    join public.source_tombstones tombstone
      on tombstone.owner_id = v_owner and tombstone.source_id = source.value->>'id'
  ) then
    raise exception using errcode='40001', message='Source was permanently deleted';
  end if;
  if p_expected_revision=0 then
    insert into public.workspaces(owner_id,data,revision) values(v_owner,p_data,1)
      on conflict (owner_id) do nothing returning revision into v_revision;
  else
    update public.workspaces set data=p_data,revision=revision+1,updated_at=now()
      where owner_id=v_owner and revision=p_expected_revision returning revision into v_revision;
  end if;
  if v_revision is null then raise exception using errcode='40001', message='Workspace revision conflict'; end if;
  perform conuo_private.project_workspace(v_owner,p_data);
  return v_revision;
end;
$$;

revoke all on function conuo_private.json_array(jsonb),
  conuo_private.purge_citations(jsonb,text),
  conuo_private.purge_citation_count(jsonb,text),
  conuo_private.relation_references_purged_source(jsonb,text),
  conuo_private.organization_job_references_purged_source(jsonb,text),
  conuo_private.sanitize_purged_source_workspace(jsonb,text),
  conuo_private.source_purge_preview(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.preview_source_purge(text), public.request_source_purge(text,bigint,text)
  from public, anon, service_role;
grant execute on function public.preview_source_purge(text), public.request_source_purge(text,bigint,text)
  to authenticated;

commit;
