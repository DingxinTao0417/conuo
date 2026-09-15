-- Preserve failed/stopped answer history while preventing a retry from using a
-- source that has since been permanently deleted.
begin;

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
            (
              (message.value - 'citations' - 'attempt') ||
              jsonb_build_object(
                'citations', conuo_private.purge_citations(message.value->'citations', p_source_id)
              ) ||
              case
                when message.value ? 'attempt' then jsonb_build_object(
                  'attempt',
                  (message.value->'attempt') ||
                  case
                    when message.value #>> '{attempt,scopeSnapshot,sourceId}' = p_source_id
                      or exists (
                        select 1
                        from jsonb_array_elements(
                          conuo_private.json_array(message.value #> '{attempt,scopeSnapshot,sourceIds}')
                        ) as attempt_source(value)
                        where attempt_source.value #>> '{}' = p_source_id
                      )
                      then jsonb_build_object('unavailableReason', 'source-purged')
                    else '{}'::jsonb
                  end
                )
                else '{}'::jsonb
              end
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

commit;
