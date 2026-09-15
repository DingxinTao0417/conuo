-- Snapshot-compatible concept-relation projection. Workspace snapshots remain the sole
-- browser write authority; this table preserves both relation fields and endpoint baselines.
begin;

create table public.concept_relations (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  relation_id text not null check (relation_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  space_id text not null check (space_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  relation_type text not null check (
    relation_type in ('synonym','related','prerequisite','conflict')
  ),
  from_note_id text not null check (from_note_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  to_note_id text not null check (to_note_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  from_revision bigint not null check (from_revision between 0 and 9007199254740990),
  to_revision bigint not null check (to_revision between 0 and 9007199254740990),
  from_updated_at timestamptz not null,
  to_updated_at timestamptz not null,
  from_snapshot jsonb not null check (jsonb_typeof(from_snapshot) = 'object'),
  to_snapshot jsonb not null check (jsonb_typeof(to_snapshot) = 'object'),
  origin text not null check (origin in ('manual','ai')),
  revision bigint not null check (revision between 0 and 9007199254740990),
  from_claim text not null check (char_length(from_claim) between 1 and 2000),
  to_claim text not null check (char_length(to_claim) between 1 and 2000),
  from_condition text not null check (char_length(from_condition) <= 1000),
  to_condition text not null check (char_length(to_condition) <= 1000),
  explanation text not null check (char_length(explanation) between 1 and 2000),
  from_citations jsonb not null check (jsonb_typeof(from_citations) = 'array'),
  to_citations jsonb not null check (jsonb_typeof(to_citations) = 'array'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  job_id text check (job_id is null or job_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  proposal_id text check (proposal_id is null or proposal_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  primary key (owner_id, relation_id),
  check (from_note_id <> to_note_id)
);

create index concept_relations_owner_space_updated_at
  on public.concept_relations (owner_id, space_id, updated_at desc);
create index concept_relations_owner_from_note
  on public.concept_relations (owner_id, from_note_id, updated_at desc)
  where deleted_at is null;
create index concept_relations_owner_to_note
  on public.concept_relations (owner_id, to_note_id, updated_at desc)
  where deleted_at is null;
create index concept_relations_owner_active_pair_type
  on public.concept_relations (
    owner_id,
    relation_type,
    (case when relation_type = 'prerequisite' then from_note_id
      else least(from_note_id, to_note_id) end),
    (case when relation_type = 'prerequisite' then to_note_id
      else greatest(from_note_id, to_note_id) end)
  ) where deleted_at is null;

alter table public.concept_relations enable row level security;
revoke all on table public.concept_relations from public, anon, authenticated, service_role;
grant select on table public.concept_relations to authenticated;

create policy "Read own projected concept relations" on public.concept_relations
  for select to authenticated
  using (owner_id = (select auth.uid()) and public.account_deletion_access_allowed());

create function conuo_private.valid_relation_citations(p_value jsonb, p_limit integer)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  citation jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'array'
    or jsonb_array_length(p_value) > p_limit then
    return false;
  end if;
  for citation in select value from jsonb_array_elements(p_value) loop
    if jsonb_typeof(citation) <> 'object'
      or not conuo_private.valid_id(citation->>'sourceId')
      or not conuo_private.valid_id(citation->>'versionId')
      or not conuo_private.valid_id(citation->>'chunkId')
      or jsonb_typeof(citation->'title') is distinct from 'string'
      or char_length(citation->>'title') > 512
      or jsonb_typeof(citation->'quote') is distinct from 'string'
      or char_length(citation->>'quote') > 3145728
      or jsonb_typeof(citation->'section') is distinct from 'string'
      or char_length(citation->>'section') > 512 then
      return false;
    end if;
    if citation ? 'page' and (
      jsonb_typeof(citation->'page') is distinct from 'number'
      or citation->>'page' !~ '^[1-9][0-9]{0,5}$'
      or (citation->>'page')::numeric > 100000
    ) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create function conuo_private.valid_knowledge_relation_snapshot(
  p_value jsonb,
  p_space_id text
) returns boolean language plpgsql immutable set search_path = '' as $$
begin
  return coalesce(p_value is not null
    and jsonb_typeof(p_value) = 'object'
    and conuo_private.valid_id(p_value->>'id')
    and p_value->>'spaceId' = p_space_id
    and jsonb_typeof(p_value->'title') = 'string'
    and char_length(p_value->>'title') <= 512
    and jsonb_typeof(p_value->'content') = 'string'
    and char_length(p_value->>'content') <= 200000
    and conuo_private.valid_relation_citations(p_value->'citations', 1000)
    and p_value->>'status' in ('draft','accepted')
    and jsonb_typeof(p_value->'aiGenerated') = 'boolean'
    and jsonb_typeof(p_value->'revision') = 'number'
    and p_value->>'revision' ~ '^(0|[1-9][0-9]{0,15})$'
    and (p_value->>'revision')::numeric <= 9007199254740990
    and jsonb_typeof(p_value->'updatedAt') = 'string', false);
end;
$$;

create function conuo_private.relation_projection_digest(p_value jsonb)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_value::text, 'UTF8')), 'hex');
$$;

create function conuo_private.project_concept_relations_from_workspace(
  p_owner uuid,
  p_data jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  relation jsonb;
  v_relations jsonb;
  v_relation_id text;
  v_relation_type text;
  v_from_note_id text;
  v_to_note_id text;
  v_pair_key text;
  v_seen_relations text[] := '{}';
  v_seen_active_pairs text[] := '{}';
  v_deleted_at timestamptz;
  v_revision bigint;
  v_from_revision bigint;
  v_to_revision bigint;
  v_digest text;
  v_existing public.concept_relations%rowtype;
  v_from_unique_evidence boolean;
  v_to_unique_evidence boolean;
begin
  if p_owner is null or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception using errcode = '22023', message = 'Invalid concept relation workspace';
  end if;
  v_relations := case
    when p_data ? 'conceptRelations' then p_data->'conceptRelations'
    else '[]'::jsonb
  end;
  if jsonb_typeof(v_relations) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid concept relation list';
  end if;
  if jsonb_array_length(v_relations) > 2000 then
    raise exception using errcode = '22023', message = 'Too many concept relations';
  end if;

  for relation in select value from jsonb_array_elements(v_relations) loop
    if jsonb_typeof(relation) is distinct from 'object'
      or not conuo_private.valid_id(relation->>'id')
      or relation->>'id' = any(v_seen_relations)
      or not conuo_private.valid_id(relation->>'spaceId')
      or coalesce(relation->>'type' not in ('synonym','related','prerequisite','conflict'), true)
      or coalesce(relation->>'origin' not in ('manual','ai'), true)
      or jsonb_typeof(relation->'revision') is distinct from 'number'
      or relation->>'revision' !~ '^(0|[1-9][0-9]{0,15})$'
      or (relation->>'revision')::numeric > 9007199254740990
      or jsonb_typeof(relation->'fromClaim') is distinct from 'string'
      or char_length(btrim(relation->>'fromClaim')) not between 1 and 2000
      or jsonb_typeof(relation->'toClaim') is distinct from 'string'
      or char_length(btrim(relation->>'toClaim')) not between 1 and 2000
      or jsonb_typeof(relation->'fromCondition') is distinct from 'string'
      or char_length(btrim(relation->>'fromCondition')) > 1000
      or jsonb_typeof(relation->'toCondition') is distinct from 'string'
      or char_length(btrim(relation->>'toCondition')) > 1000
      or jsonb_typeof(relation->'explanation') is distinct from 'string'
      or char_length(btrim(relation->>'explanation')) not between 1 and 2000
      or not conuo_private.valid_relation_citations(relation->'fromCitations', 6)
      or not conuo_private.valid_relation_citations(relation->'toCitations', 6)
      or not (relation ? 'createdAt')
      or jsonb_typeof(relation->'createdAt') is distinct from 'string'
      or not (relation ? 'updatedAt')
      or jsonb_typeof(relation->'updatedAt') is distinct from 'string'
      or not (relation ? 'deletedAt')
      or (jsonb_typeof(relation->'deletedAt') <> 'string'
        and jsonb_typeof(relation->'deletedAt') <> 'null') then
      raise exception using errcode = '22023', message = 'Invalid concept relation snapshot';
    end if;
    if relation ? 'jobId' and (
      jsonb_typeof(relation->'jobId') is distinct from 'string'
      or not coalesce(conuo_private.valid_id(relation->>'jobId'), false)
    ) then
      raise exception using errcode = '22023', message = 'Invalid concept relation job';
    end if;
    if relation ? 'proposalId' and (
      jsonb_typeof(relation->'proposalId') is distinct from 'string'
      or not coalesce(conuo_private.valid_id(relation->>'proposalId'), false)
    ) then
      raise exception using errcode = '22023', message = 'Invalid concept relation proposal';
    end if;
    if not conuo_private.valid_knowledge_relation_snapshot(
      relation->'from', relation->>'spaceId'
    ) or not conuo_private.valid_knowledge_relation_snapshot(
      relation->'to', relation->>'spaceId'
    ) then
      raise exception using errcode = '22023', message = 'Invalid relation endpoint snapshot';
    end if;

    v_relation_id := relation->>'id';
    v_relation_type := relation->>'type';
    v_from_note_id := relation #>> '{from,id}';
    v_to_note_id := relation #>> '{to,id}';
    if v_from_note_id = v_to_note_id then
      raise exception using errcode = '22023', message = 'Relation endpoints must differ';
    end if;
    if relation->>'origin' = 'manual'
      and jsonb_array_length(relation->'fromCitations') = 0
      and jsonb_array_length(relation->'toCitations') = 0 then
      raise exception using errcode = '22023', message = 'Manual relation requires evidence';
    end if;

    if v_relation_type = 'conflict' then
      if btrim(relation->>'fromCondition') = '' or btrim(relation->>'toCondition') = ''
        or regexp_replace(relation->>'fromClaim', '\s+', '', 'g')
          = regexp_replace(relation->>'toClaim', '\s+', '', 'g') then
        raise exception using errcode = '22023', message = 'Invalid conflict relation';
      end if;
      select exists (
        select 1 from jsonb_array_elements(relation->'fromCitations') from_citation
        where not exists (
          select 1 from jsonb_array_elements(relation->'toCitations') to_citation
          where to_citation->>'sourceId' = from_citation->>'sourceId'
            and to_citation->>'versionId' = from_citation->>'versionId'
            and to_citation->>'chunkId' = from_citation->>'chunkId'
        )
      ) into v_from_unique_evidence;
      select exists (
        select 1 from jsonb_array_elements(relation->'toCitations') to_citation
        where not exists (
          select 1 from jsonb_array_elements(relation->'fromCitations') from_citation
          where from_citation->>'sourceId' = to_citation->>'sourceId'
            and from_citation->>'versionId' = to_citation->>'versionId'
            and from_citation->>'chunkId' = to_citation->>'chunkId'
        )
      ) into v_to_unique_evidence;
      if not v_from_unique_evidence or not v_to_unique_evidence then
        raise exception using errcode = '22023', message = 'Conflict relation requires distinct evidence';
      end if;
    end if;

    v_deleted_at := case
      when jsonb_typeof(relation->'deletedAt') = 'string'
        then (relation->>'deletedAt')::timestamptz
      else null
    end;
    v_pair_key := v_relation_type || ':' || case
      when v_relation_type = 'prerequisite' then v_from_note_id || ':' || v_to_note_id
      else least(v_from_note_id, v_to_note_id) || ':' || greatest(v_from_note_id, v_to_note_id)
    end;
    if v_deleted_at is null and v_pair_key = any(v_seen_active_pairs) then
      raise exception using errcode = '22023', message = 'Duplicate active concept relation';
    end if;
    if v_deleted_at is null then
      v_seen_active_pairs := array_append(v_seen_active_pairs, v_pair_key);
    end if;
    v_seen_relations := array_append(v_seen_relations, v_relation_id);
    v_revision := (relation->>'revision')::bigint;
    v_from_revision := (relation #>> '{from,revision}')::bigint;
    v_to_revision := (relation #>> '{to,revision}')::bigint;
    v_digest := conuo_private.relation_projection_digest(relation);

    select * into v_existing from public.concept_relations existing
      where existing.owner_id = p_owner and existing.relation_id = v_relation_id;
    if found and v_existing.snapshot_digest is distinct from v_digest then
      if v_revision <> v_existing.revision + 1
        or relation->>'origin' is distinct from v_existing.origin
        or (relation->>'createdAt')::timestamptz is distinct from v_existing.created_at
        or (case when relation ? 'jobId' then relation->>'jobId' else null end)
          is distinct from v_existing.job_id
        or (case when relation ? 'proposalId' then relation->>'proposalId' else null end)
          is distinct from v_existing.proposal_id then
        raise exception using errcode = '40001', message = 'Concept relation revision changed';
      end if;
    end if;

    insert into public.concept_relations (
      owner_id, relation_id, space_id, relation_type, from_note_id, to_note_id,
      from_revision, to_revision, from_updated_at, to_updated_at, from_snapshot,
      to_snapshot, origin, revision, from_claim, to_claim, from_condition,
      to_condition, explanation, from_citations, to_citations, created_at,
      updated_at, deleted_at, job_id, proposal_id, snapshot_digest
    ) values (
      p_owner, v_relation_id, relation->>'spaceId', v_relation_type,
      v_from_note_id, v_to_note_id, v_from_revision, v_to_revision,
      (relation #>> '{from,updatedAt}')::timestamptz,
      (relation #>> '{to,updatedAt}')::timestamptz, relation->'from', relation->'to',
      relation->>'origin', v_revision, btrim(relation->>'fromClaim'),
      btrim(relation->>'toClaim'), btrim(relation->>'fromCondition'),
      btrim(relation->>'toCondition'), btrim(relation->>'explanation'),
      relation->'fromCitations', relation->'toCitations',
      (relation->>'createdAt')::timestamptz, (relation->>'updatedAt')::timestamptz,
      v_deleted_at, case when relation ? 'jobId' then relation->>'jobId' else null end,
      case when relation ? 'proposalId' then relation->>'proposalId' else null end, v_digest
    )
    on conflict (owner_id, relation_id) do update set
      space_id = excluded.space_id,
      relation_type = excluded.relation_type,
      from_note_id = excluded.from_note_id,
      to_note_id = excluded.to_note_id,
      from_revision = excluded.from_revision,
      to_revision = excluded.to_revision,
      from_updated_at = excluded.from_updated_at,
      to_updated_at = excluded.to_updated_at,
      from_snapshot = excluded.from_snapshot,
      to_snapshot = excluded.to_snapshot,
      origin = excluded.origin,
      revision = excluded.revision,
      from_claim = excluded.from_claim,
      to_claim = excluded.to_claim,
      from_condition = excluded.from_condition,
      to_condition = excluded.to_condition,
      explanation = excluded.explanation,
      from_citations = excluded.from_citations,
      to_citations = excluded.to_citations,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at,
      job_id = excluded.job_id,
      proposal_id = excluded.proposal_id,
      snapshot_digest = excluded.snapshot_digest
    where public.concept_relations.snapshot_digest is distinct from excluded.snapshot_digest;
  end loop;

  delete from public.concept_relations relation_row
    where relation_row.owner_id = p_owner
      and not (relation_row.relation_id = any(v_seen_relations));
end;
$$;

create function conuo_private.project_concept_relations_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform conuo_private.project_concept_relations_from_workspace(new.owner_id, new.data);
  return new;
end;
$$;

create trigger project_workspace_concept_relations
after insert or update of data on public.workspaces
for each row execute function conuo_private.project_concept_relations_from_workspace_trigger();

do $$
declare w record;
begin
  for w in select owner_id, data from public.workspaces loop
    perform pg_advisory_xact_lock(hashtextextended('conuo:source:' || w.owner_id::text, 0));
    perform conuo_private.project_concept_relations_from_workspace(w.owner_id, w.data);
  end loop;
end;
$$;

revoke all on function conuo_private.valid_relation_citations(jsonb,integer),
  conuo_private.valid_knowledge_relation_snapshot(jsonb,text),
  conuo_private.relation_projection_digest(jsonb),
  conuo_private.project_concept_relations_from_workspace(uuid,jsonb),
  conuo_private.project_concept_relations_from_workspace_trigger()
  from public, anon, authenticated, service_role;

comment on table public.concept_relations is
  'Read projection of workspaces.data.conceptRelations with frozen endpoint baselines.';
commit;
