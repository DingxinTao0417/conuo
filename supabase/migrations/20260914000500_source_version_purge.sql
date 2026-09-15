-- A historical version is a separately retained immutable original. Deleting it must
-- update the workspace JSONB, normalized retrieval rows, and Storage cleanup outbox in
-- one database transaction. Reuse source_purges/source_purge_objects so the existing
-- trusted worker supplies the same bounded leases and retry behavior for both scopes.
begin;

alter table public.source_purges
  add column purge_scope text not null default 'source'
    check (purge_scope in ('source', 'version')),
  add column version_id text;

alter table public.source_purges
  add constraint source_purges_scope_version_check check (
    (purge_scope = 'source' and version_id is null)
    or (purge_scope = 'version' and version_id ~ '^[a-zA-Z0-9_-]{1,100}$')
  );

drop index public.source_purges_owner_source;
create unique index source_purges_owner_source on public.source_purges(owner_id, source_id)
  where purge_scope = 'source';
create unique index source_version_purges_owner_source_version
  on public.source_purges(owner_id, source_id, version_id)
  where purge_scope = 'version';

create function conuo_private.version_citation_count(
  p_citations jsonb,
  p_source_id text,
  p_version_id text
) returns integer language sql immutable set search_path = '' as $$
  select count(*)::integer
  from jsonb_array_elements(conuo_private.json_array(p_citations)) as citation(value)
  where citation.value->>'sourceId' = p_source_id
    and citation.value->>'versionId' = p_version_id;
$$;

create function conuo_private.relation_references_purged_version(
  p_relation jsonb,
  p_source_id text,
  p_version_id text
) returns boolean language sql immutable set search_path = '' as $$
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
      and citation.value->>'versionId' = p_version_id
  );
$$;

create function conuo_private.organization_job_references_purged_version(
  p_job jsonb,
  p_source_id text,
  p_version_id text
) returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1
    from jsonb_array_elements(conuo_private.json_array(p_job#>'{request,sourceVersions}')) as version(value)
    where version.value->>'sourceId' = p_source_id
      and version.value->>'versionId' = p_version_id
  );
$$;

-- User-authored note and conversation text stays readable. Their citation has a saved
-- quote and becomes historically unavailable rather than being substituted with a
-- current version. Highlights without a note and AI-derived records are removable.
create function conuo_private.sanitize_purged_source_version_workspace(
  p_data jsonb,
  p_source_id text,
  p_version_id text
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_sources jsonb;
  v_annotations jsonb;
  v_import_jobs jsonb;
  v_organization_jobs jsonb;
  v_relations jsonb;
begin
  select coalesce(jsonb_agg(
    case when source.value->>'id' = p_source_id then
      (source.value - 'versions') || jsonb_build_object('versions', coalesce((
        select jsonb_agg(version.value order by version.ordinality)
        from jsonb_array_elements(conuo_private.json_array(source.value->'versions'))
          with ordinality as version(value, ordinality)
        where version.value->>'versionId' is distinct from p_version_id
      ), '[]'::jsonb))
    else source.value end
    order by source.ordinality
  ), '[]'::jsonb)
    into v_sources
    from jsonb_array_elements(conuo_private.json_array(p_data->'sources'))
      with ordinality as source(value, ordinality);

  select coalesce(jsonb_agg(annotation.value order by annotation.ordinality), '[]'::jsonb)
    into v_annotations
    from jsonb_array_elements(conuo_private.json_array(p_data->'annotations'))
      with ordinality as annotation(value, ordinality)
    where annotation.value->>'sourceId' is distinct from p_source_id
      or annotation.value->>'versionId' is distinct from p_version_id;

  if p_data ? 'importJobs' then
    select coalesce(jsonb_agg(job.value order by job.ordinality), '[]'::jsonb)
      into v_import_jobs
      from jsonb_array_elements(conuo_private.json_array(p_data->'importJobs'))
        with ordinality as job(value, ordinality)
      where job.value->>'sourceId' is distinct from p_source_id
        or job.value->>'versionId' is distinct from p_version_id;
  end if;

  if p_data ? 'organizationJobs' then
    select coalesce(jsonb_agg(job.value order by job.ordinality), '[]'::jsonb)
      into v_organization_jobs
      from jsonb_array_elements(conuo_private.json_array(p_data->'organizationJobs'))
        with ordinality as job(value, ordinality)
      where not conuo_private.organization_job_references_purged_version(
        job.value, p_source_id, p_version_id
      );
  end if;

  if p_data ? 'conceptRelations' then
    select coalesce(jsonb_agg(relation.value order by relation.ordinality), '[]'::jsonb)
      into v_relations
      from jsonb_array_elements(conuo_private.json_array(p_data->'conceptRelations'))
        with ordinality as relation(value, ordinality)
      where not (
        relation.value->>'origin' = 'ai'
        and conuo_private.relation_references_purged_version(
          relation.value, p_source_id, p_version_id
        )
      );
  end if;

  return (p_data - 'sources' - 'annotations' - 'importJobs' - 'organizationJobs' - 'conceptRelations') ||
    jsonb_build_object('sources', v_sources, 'annotations', v_annotations) ||
    case when p_data ? 'importJobs' then jsonb_build_object('importJobs', v_import_jobs) else '{}'::jsonb end ||
    case when p_data ? 'organizationJobs' then jsonb_build_object('organizationJobs', v_organization_jobs) else '{}'::jsonb end ||
    case when p_data ? 'conceptRelations' then jsonb_build_object('conceptRelations', v_relations) else '{}'::jsonb end;
end;
$$;

-- The client gets only this derived impact and a one-use fingerprint. Object paths,
-- normalized rows, and the dependency list always come from the current server state.
create function conuo_private.source_version_purge_preview(
  p_owner uuid,
  p_source_id text,
  p_version_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_workspace public.workspaces%rowtype;
  v_source public.sources%rowtype;
  v_version public.source_versions%rowtype;
  v_history_matches integer := 0;
  v_paths jsonb := '[]'::jsonb;
  v_blob_keys jsonb := '[]'::jsonb;
  v_annotations jsonb := '[]'::jsonb;
  v_annotation_blockers jsonb := '[]'::jsonb;
  v_notes jsonb := '[]'::jsonb;
  v_conversations jsonb := '[]'::jsonb;
  v_organization_jobs jsonb := '[]'::jsonb;
  v_organization_blockers jsonb := '[]'::jsonb;
  v_ai_relations jsonb := '[]'::jsonb;
  v_manual_relations jsonb := '[]'::jsonb;
  v_import_jobs jsonb := '[]'::jsonb;
  v_import_blockers jsonb := '[]'::jsonb;
  v_note_citations integer := 0;
  v_conversation_citations integer := 0;
  v_impact jsonb;
  v_blockers jsonb;
  v_fingerprint text;
begin
  if p_owner is null or not conuo_private.valid_id(p_source_id)
    or not conuo_private.valid_id(p_version_id) then
    raise exception using errcode = '22023', message = 'Invalid source version purge request';
  end if;
  select * into v_workspace from public.workspaces where owner_id = p_owner;
  if not found then
    raise exception using errcode = '22023', message = 'Source version unavailable for deletion';
  end if;
  select * into v_source
    from public.sources
    where owner_id = p_owner and source_id = p_source_id;
  if not found or v_source.deleted_at is not null or v_source.current_version_id = p_version_id then
    raise exception using errcode = '22023', message = 'Source version unavailable for deletion';
  end if;
  select count(*)::integer into v_history_matches
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'sources')) as source(value)
    cross join lateral jsonb_array_elements(conuo_private.json_array(source.value->'versions')) as version(value)
    where source.value->>'id' = p_source_id
      and source.value->>'deletedAt' is null
      and source.value->>'versionId' = v_source.current_version_id
      and version.value->>'versionId' = p_version_id;
  if v_history_matches <> 1 then
    raise exception using errcode = '22023', message = 'Source version unavailable for deletion';
  end if;
  select * into v_version
    from public.source_versions
    where owner_id = p_owner and source_id = p_source_id and version_id = p_version_id and retained;
  if not found then
    raise exception using errcode = '22023', message = 'Source version unavailable for deletion';
  end if;

  -- A malformed snapshot must not cause a shared original to be deleted. Retain paths
  -- still used by another projected version; browser cleanup applies the same rule to
  -- blob keys independently.
  select coalesce(jsonb_agg(to_jsonb(v_version.storage_path)), '[]'::jsonb)
    into v_paths
    where v_version.storage_path is not null
      and not exists (
        select 1 from public.source_versions other
        where other.owner_id = p_owner
          and other.storage_path = v_version.storage_path
          and other.retained
          and (other.source_id, other.version_id) <> (p_source_id, p_version_id)
      );
  select coalesce(jsonb_agg(to_jsonb(v_version.blob_key)), '[]'::jsonb)
    into v_blob_keys
    where v_version.blob_key is not null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', annotation.value->>'id',
    'hasSavedNote', length(btrim(coalesce(annotation.value->>'note', ''))) > 0
  ) order by annotation.value->>'id'), '[]'::jsonb),
  coalesce(jsonb_agg(to_jsonb(annotation.value->>'id') order by annotation.value->>'id')
    filter (where length(btrim(coalesce(annotation.value->>'note', ''))) > 0), '[]'::jsonb)
    into v_annotations, v_annotation_blockers
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'annotations')) as annotation(value)
    where annotation.value->>'sourceId' = p_source_id
      and annotation.value->>'versionId' = p_version_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', refs.note->>'id', 'citations', refs.citations)
    order by refs.note->>'id'), '[]'::jsonb), coalesce(sum(refs.citations), 0)::integer
    into v_notes, v_note_citations
    from (
      select note.value as note,
        conuo_private.version_citation_count(note.value->'citations', p_source_id, p_version_id) + coalesce((
          select sum(conuo_private.version_citation_count(version.value->'citations', p_source_id, p_version_id))::integer
          from jsonb_array_elements(conuo_private.json_array(note.value->'versions')) as version(value)
        ), 0) as citations
      from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'notes')) as note(value)
    ) as refs where refs.citations > 0;

  select coalesce(jsonb_agg(jsonb_build_object('id', refs.conversation->>'id', 'citations', refs.citations)
    order by refs.conversation->>'id'), '[]'::jsonb), coalesce(sum(refs.citations), 0)::integer
    into v_conversations, v_conversation_citations
    from (
      select conversation.value as conversation, coalesce((
        select sum(conuo_private.version_citation_count(message.value->'citations', p_source_id, p_version_id))::integer
        from jsonb_array_elements(conuo_private.json_array(conversation.value->'messages')) as message(value)
      ), 0) as citations
      from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'conversations')) as conversation(value)
    ) as refs where refs.citations > 0;

  select coalesce(jsonb_agg(jsonb_build_object('id', job.value->>'id', 'status', job.value->>'status')
    order by job.value->>'id'), '[]'::jsonb),
  coalesce(jsonb_agg(to_jsonb(job.value->>'id') order by job.value->>'id')
    filter (where job.value->>'status' in ('queued', 'running')), '[]'::jsonb)
    into v_organization_jobs, v_organization_blockers
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'organizationJobs')) as job(value)
    where conuo_private.organization_job_references_purged_version(job.value, p_source_id, p_version_id);

  select coalesce(jsonb_agg(to_jsonb(relation.value->>'id') order by relation.value->>'id')
    filter (where relation.value->>'origin' = 'ai'), '[]'::jsonb),
  coalesce(jsonb_agg(to_jsonb(relation.value->>'id') order by relation.value->>'id')
    filter (where relation.value->>'origin' = 'manual'), '[]'::jsonb)
    into v_ai_relations, v_manual_relations
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'conceptRelations')) as relation(value)
    where conuo_private.relation_references_purged_version(relation.value, p_source_id, p_version_id);

  select coalesce(jsonb_agg(jsonb_build_object('id', job.value->>'id', 'status', job.value->>'status')
    order by job.value->>'id'), '[]'::jsonb),
  coalesce(jsonb_agg(to_jsonb(job.value->>'id') order by job.value->>'id')
    filter (where job.value->>'status' in ('queued', 'running')), '[]'::jsonb)
    into v_import_jobs, v_import_blockers
    from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'importJobs')) as job(value)
    where job.value->>'sourceId' = p_source_id and job.value->>'versionId' = p_version_id;

  v_impact := jsonb_build_object(
    'source', jsonb_build_object('id', v_source.source_id, 'title', v_source.title),
    'version', jsonb_build_object(
      'versionId', v_version.version_id,
      'filename', v_version.manifest->>'filename',
      'createdAt', (
        select version.value->>'createdAt'
        from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'sources')) as source(value)
        cross join lateral jsonb_array_elements(conuo_private.json_array(source.value->'versions')) as version(value)
        where source.value->>'id' = p_source_id and version.value->>'versionId' = p_version_id
      ),
      'archivedAt', (
        select version.value->>'archivedAt'
        from jsonb_array_elements(conuo_private.json_array(v_workspace.data->'sources')) as source(value)
        cross join lateral jsonb_array_elements(conuo_private.json_array(source.value->'versions')) as version(value)
        where source.value->>'id' = p_source_id and version.value->>'versionId' = p_version_id
      )
    ),
    'annotations', jsonb_array_length(v_annotations) - jsonb_array_length(v_annotation_blockers),
    'blockingAnnotations', jsonb_array_length(v_annotation_blockers),
    'retainedNotes', jsonb_array_length(v_notes),
    'retainedNoteCitations', v_note_citations,
    'retainedConversations', jsonb_array_length(v_conversations),
    'retainedConversationCitations', v_conversation_citations,
    'organizationJobs', jsonb_array_length(v_organization_jobs) - jsonb_array_length(v_organization_blockers),
    'blockingOrganizationJobs', jsonb_array_length(v_organization_blockers),
    'conceptRelations', jsonb_array_length(v_ai_relations),
    'blockingConceptRelations', jsonb_array_length(v_manual_relations),
    'importJobs', jsonb_array_length(v_import_jobs) - jsonb_array_length(v_import_blockers),
    'blockingImportJobs', jsonb_array_length(v_import_blockers),
    'localOriginals', jsonb_array_length(v_blob_keys),
    'cloudOriginals', jsonb_array_length(v_paths),
    'storageObjects', jsonb_array_length(v_paths)
  );
  v_blockers := jsonb_build_object(
    'annotations', v_annotation_blockers,
    'conceptRelations', v_manual_relations,
    'organizationJobs', v_organization_blockers,
    'importJobs', v_import_blockers
  );
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'revision', v_workspace.revision,
    'source', jsonb_build_object(
      'id', v_source.source_id,
      'currentVersionId', v_source.current_version_id,
      'versionId', v_version.version_id,
      'contentDigest', v_version.content_digest,
      'storagePaths', v_paths,
      'blobKeys', v_blob_keys
    ),
    'impact', v_impact,
    'blockers', v_blockers,
    'annotations', v_annotations,
    'notes', v_notes,
    'conversations', v_conversations,
    'organizationJobs', v_organization_jobs,
    'aiRelations', v_ai_relations,
    'manualRelations', v_manual_relations,
    'importJobs', v_import_jobs
  )::text, 'utf8')), 'hex');
  return jsonb_build_object(
    'revision', v_workspace.revision,
    'fingerprint', v_fingerprint,
    'impact', v_impact,
    'blockers', v_blockers
  );
end;
$$;

create function public.preview_source_version_purge(
  p_source_id text,
  p_version_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  return conuo_private.source_version_purge_preview(v_owner, p_source_id, p_version_id);
end;
$$;

create function public.request_source_version_purge(
  p_source_id text,
  p_version_id text,
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
  v_cleanup_pending boolean;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id)
    or p_expected_revision is null or p_expected_revision < 1
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid source version purge confirmation';
  end if;
  perform conuo_private.owner_lock(v_owner);
  select * into v_workspace from public.workspaces where owner_id = v_owner for update;
  if not found or v_workspace.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  v_preview := conuo_private.source_version_purge_preview(v_owner, p_source_id, p_version_id);
  if v_preview->>'fingerprint' <> p_fingerprint then
    raise exception using errcode = '40001', message = 'Source version purge impact changed';
  end if;
  if jsonb_array_length(v_preview->'blockers'->'annotations') > 0
    or jsonb_array_length(v_preview->'blockers'->'conceptRelations') > 0
    or jsonb_array_length(v_preview->'blockers'->'organizationJobs') > 0
    or jsonb_array_length(v_preview->'blockers'->'importJobs') > 0 then
    raise exception using errcode = 'P0001', message = 'Saved content or active work must be resolved before source version deletion';
  end if;
  v_data := conuo_private.sanitize_purged_source_version_workspace(
    v_workspace.data, p_source_id, p_version_id
  );
  v_cleanup_pending := (v_preview->'impact'->>'storageObjects')::integer > 0;
  insert into public.source_purges(
    purge_id, owner_id, source_id, version_id, purge_scope, workspace_revision, state, completed_at
  ) values (
    v_purge_id, v_owner, p_source_id, p_version_id, 'version', v_workspace.revision + 1,
    case when v_cleanup_pending then 'pending' else 'completed' end,
    case when v_cleanup_pending then null else now() end
  );
  insert into public.source_purge_objects(purge_id, storage_path)
    select v_purge_id, version.storage_path
    from public.source_versions version
    where version.owner_id = v_owner and version.source_id = p_source_id
      and version.version_id = p_version_id and version.storage_path is not null
      and not exists (
        select 1 from public.source_versions other
        where other.owner_id = v_owner and other.storage_path = version.storage_path
          and other.retained
          and (other.source_id, other.version_id) <> (p_source_id, p_version_id)
      );
  update public.workspaces
    set data = v_data, revision = revision + 1, updated_at = now()
    where owner_id = v_owner and revision = v_workspace.revision
    returning revision into v_revision;
  if v_revision is null then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  perform conuo_private.project_workspace(v_owner, v_data);
  delete from public.source_versions
    where owner_id = v_owner and source_id = p_source_id and version_id = p_version_id;
  return jsonb_build_object(
    'revision', v_revision,
    'data', v_data,
    'purgeId', v_purge_id,
    'cleanupPending', v_cleanup_pending
  );
end;
$$;

revoke all on function conuo_private.version_citation_count(jsonb,text,text),
  conuo_private.relation_references_purged_version(jsonb,text,text),
  conuo_private.organization_job_references_purged_version(jsonb,text,text),
  conuo_private.sanitize_purged_source_version_workspace(jsonb,text,text),
  conuo_private.source_version_purge_preview(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.preview_source_version_purge(text,text),
  public.request_source_version_purge(text,text,bigint,text)
  from public, anon, service_role;
grant execute on function public.preview_source_version_purge(text,text),
  public.request_source_version_purge(text,text,bigint,text)
  to authenticated;

commit;
