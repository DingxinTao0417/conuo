begin;

create table public.space_glossary_terms (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  space_id text not null,
  term_id text not null check (term_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  term text not null check (char_length(btrim(term)) between 1 and 80),
  aliases text[] not null default '{}',
  definition jsonb not null,
  status text not null check (status in ('accepted','rejected')),
  origin text not null check (origin in ('ai','user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, space_id, term_id),
  foreign key (owner_id, space_id) references public.learning_spaces(owner_id, space_id)
    on delete cascade,
  check (cardinality(aliases) between 0 and 10)
);

create index space_glossary_terms_lookup
  on public.space_glossary_terms (owner_id, space_id, status, updated_at desc);

alter table public.space_glossary_terms enable row level security;
revoke all on table public.space_glossary_terms from public, anon, authenticated, service_role;

create function conuo_private.valid_glossary_definition(
  p_owner uuid,
  p_space text,
  p_definition jsonb
) returns boolean language sql stable set search_path = '' as $$
  select coalesce(
    jsonb_typeof(p_definition) = 'object'
    and jsonb_typeof(p_definition->'text') = 'string'
    and char_length(btrim(p_definition->>'text')) between 1 and 600
    and jsonb_typeof(p_definition->'chunkRefs') = 'array'
    and jsonb_array_length(p_definition->'chunkRefs') between 1 and 3
    and not exists (
      select 1
      from jsonb_array_elements(p_definition->'chunkRefs') ref
      where jsonb_typeof(ref) is distinct from 'object'
        or not conuo_private.valid_id(ref->>'sourceId')
        or not conuo_private.valid_id(ref->>'versionId')
        or not conuo_private.valid_id(ref->>'chunkId')
        or not exists (
          select 1
          from public.sources s
          join public.source_chunks c on c.owner_id = s.owner_id
            and c.source_id = s.source_id
            and c.version_id = s.current_version_id
          where s.owner_id = p_owner
            and s.source_id = ref->>'sourceId'
            and s.current_version_id = ref->>'versionId'
            and s.deleted_at is null
            and s.retained
            and p_space = any(s.space_ids)
            and c.chunk_id = ref->>'chunkId'
            and c.text is not null
        )
    ), false
  );
$$;

create function public.list_glossary_terms(p_space_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  rows jsonb;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not conuo_private.valid_id(p_space_id) then
    raise exception using errcode = '22023', message = 'Invalid glossary space';
  end if;
  perform conuo_private.assert_account_access(v_owner);
  if not exists (
    select 1 from public.learning_spaces
    where owner_id = v_owner and space_id = p_space_id and not archived
  ) then
    raise exception using errcode = 'PT409', message = 'Glossary space unavailable';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'termId', t.term_id,
    'spaceId', t.space_id,
    'term', t.term,
    'aliases', t.aliases,
    'definition', t.definition,
    'status', t.status,
    'origin', t.origin,
    'createdAt', t.created_at,
    'updatedAt', t.updated_at
  ) order by t.term), '[]'::jsonb)
  into rows
  from public.space_glossary_terms t
  where t.owner_id = v_owner and t.space_id = p_space_id;
  return rows;
end;
$$;

create function public.upsert_glossary_term(
  p_space_id text,
  p_term_id text,
  p_term text,
  p_aliases text[],
  p_definition jsonb,
  p_status text,
  p_origin text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  row_value public.space_glossary_terms;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not conuo_private.valid_id(p_space_id)
    or not conuo_private.valid_id(p_term_id)
    or p_term is null
    or char_length(btrim(p_term)) not between 1 and 80
    or p_aliases is null
    or cardinality(p_aliases) > 10
    or exists (
      select 1 from unnest(p_aliases) alias_value
      where alias_value is null or char_length(btrim(alias_value)) not between 1 and 80
    )
    or p_status not in ('accepted','rejected')
    or p_origin not in ('ai','user')
  then
    raise exception using errcode = '22023', message = 'Invalid glossary term';
  end if;
  perform conuo_private.assert_account_access(v_owner);
  if not exists (
    select 1 from public.learning_spaces
    where owner_id = v_owner and space_id = p_space_id and not archived
  ) then
    raise exception using errcode = 'PT409', message = 'Glossary space unavailable';
  end if;
  if not conuo_private.valid_glossary_definition(v_owner, p_space_id, p_definition) then
    raise exception using errcode = '22023', message = 'Invalid glossary definition';
  end if;
  insert into public.space_glossary_terms(
    owner_id, space_id, term_id, term, aliases, definition, status, origin
  ) values (
    v_owner, p_space_id, p_term_id, btrim(p_term),
    array(select btrim(alias_value) from unnest(p_aliases) alias_value),
    jsonb_build_object(
      'text', btrim(p_definition->>'text'),
      'chunkRefs', p_definition->'chunkRefs'
    ),
    p_status, p_origin
  )
  on conflict (owner_id, space_id, term_id) do update set
    term = excluded.term,
    aliases = excluded.aliases,
    definition = excluded.definition,
    status = excluded.status,
    origin = excluded.origin,
    updated_at = now()
  returning * into row_value;
  return jsonb_build_object(
    'termId', row_value.term_id,
    'spaceId', row_value.space_id,
    'term', row_value.term,
    'aliases', row_value.aliases,
    'definition', row_value.definition,
    'status', row_value.status,
    'origin', row_value.origin,
    'createdAt', row_value.created_at,
    'updatedAt', row_value.updated_at
  );
end;
$$;

create function public.delete_glossary_term(p_space_id text, p_term_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  removed integer;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not conuo_private.valid_id(p_space_id) or not conuo_private.valid_id(p_term_id) then
    raise exception using errcode = '22023', message = 'Invalid glossary term';
  end if;
  perform conuo_private.assert_account_access(v_owner);
  delete from public.space_glossary_terms
    where owner_id = v_owner and space_id = p_space_id and term_id = p_term_id;
  get diagnostics removed = row_count;
  return jsonb_build_object('deleted', removed = 1, 'termId', p_term_id, 'spaceId', p_space_id);
end;
$$;

revoke all on function conuo_private.valid_glossary_definition(uuid,text,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.list_glossary_terms(text),
  public.upsert_glossary_term(text,text,text,text[],jsonb,text,text),
  public.delete_glossary_term(text,text)
  from public, anon, service_role;
grant execute on function public.list_glossary_terms(text),
  public.upsert_glossary_term(text,text,text,text[],jsonb,text,text),
  public.delete_glossary_term(text,text)
  to authenticated;

comment on table public.space_glossary_terms is
  'Owner-scoped accepted and rejected glossary terms; definitions point only to current source chunks.';
commit;
