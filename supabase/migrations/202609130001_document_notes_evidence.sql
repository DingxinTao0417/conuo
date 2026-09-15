-- Upgrade persistent source-purge semantics for document-scoped personal-note evidence.
-- Personal-note evidence remains a historical answer snapshot after its associated
-- source is purged; source citations are still stripped and the conversation cannot
-- be used as a new document-scoped request.
begin;

create or replace function conuo_private.purge_note_evidence_count(p_evidence jsonb, p_source_id text)
returns integer language sql immutable set search_path = '' as $$
  select count(*)::integer
  from jsonb_array_elements(conuo_private.json_array(p_evidence)) as evidence(value)
  where evidence.value->>'sourceId' = p_source_id;
$$;
create or replace function conuo_private.sanitize_purged_source_workspace(p_data jsonb, p_source_id text)
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
        when conversation.value->>'sourceId' = p_source_id and conversation.value->>'scope' in ('document', 'document-notes')
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

create or replace function conuo_private.source_purge_preview(p_owner uuid, p_source_id text) returns jsonb
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
          select sum(
            conuo_private.purge_citation_count(message.value->'citations', p_source_id) +
            conuo_private.purge_note_evidence_count(message.value->'noteEvidence', p_source_id)
          )::integer
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

commit;

