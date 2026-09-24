begin;

create table public.source_outlines (
  owner_id uuid not null,
  source_id text not null,
  version_id text not null,
  method text not null check (method in ('pdf-outline','heading-heuristic','docx-headings','markdown-headings')),
  items jsonb not null check (
    jsonb_typeof(items) = 'array'
    and jsonb_array_length(items) <= 1000
    and octet_length(items::text) <= 131072
  ),
  updated_at timestamptz not null default now(),
  primary key (owner_id, source_id, version_id),
  foreign key (owner_id, source_id, version_id)
    references public.source_versions on delete cascade
);

alter table public.source_outlines enable row level security;
revoke all on table public.source_outlines from public, anon, authenticated, service_role;

create function public.save_source_outline(
  p_source_id text,
  p_version_id text,
  p_method text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_item jsonb;
  v_saved public.source_outlines%rowtype;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not conuo_private.valid_id(p_source_id)
     or not conuo_private.valid_id(p_version_id)
     or p_method not in ('pdf-outline','heading-heuristic','docx-headings','markdown-headings')
     or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) > 1000
     or octet_length(p_items::text) > 131072 then
    raise exception using errcode = '22023', message = 'Invalid source outline';
  end if;
  perform conuo_private.assert_account_access(v_owner);
  if not exists (
    select 1 from public.source_versions v
    join public.sources s using (owner_id, source_id)
    where v.owner_id = v_owner and v.source_id = p_source_id and v.version_id = p_version_id
      and v.retained and s.retained
  ) then
    raise exception using errcode = '22023', message = 'Source version is unavailable';
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or (select count(*) from jsonb_object_keys(v_item)) not between 2 and 3
       or not (v_item ? 'title')
       or not (v_item ? 'level')
       or exists (
         select 1 from jsonb_object_keys(v_item) as key
         where key not in ('title','level','page')
       )
       or jsonb_typeof(v_item->'title') is distinct from 'string'
       or char_length(v_item->>'title') not between 1 and 200
       or jsonb_typeof(v_item->'level') is distinct from 'number'
       or (v_item->>'level') !~ '^[1-6]$'
       or ((v_item ? 'page') and (
         jsonb_typeof(v_item->'page') is distinct from 'number'
         or (v_item->>'page') !~ '^(?:[1-9][0-9]{0,4}|100000)$'
       )) then
      raise exception using errcode = '22023', message = 'Invalid source outline item';
    end if;
  end loop;
  insert into public.source_outlines(owner_id, source_id, version_id, method, items)
    values (v_owner, p_source_id, p_version_id, p_method, p_items)
    on conflict (owner_id, source_id, version_id) do update set
      method = excluded.method,
      items = excluded.items,
      updated_at = now()
    returning * into v_saved;
  return jsonb_build_object(
    'sourceId', v_saved.source_id,
    'versionId', v_saved.version_id,
    'method', v_saved.method,
    'items', v_saved.items,
    'updatedAt', v_saved.updated_at
  );
end;
$$;

create function public.read_source_outlines(p_refs jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_ref jsonb;
  v_result jsonb := '[]'::jsonb;
  v_row public.source_outlines%rowtype;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if jsonb_typeof(p_refs) is distinct from 'array' or jsonb_array_length(p_refs) > 20 then
    raise exception using errcode = '22023', message = 'Invalid source outline references';
  end if;
  perform conuo_private.assert_account_access(v_owner);
  for v_ref in select value from jsonb_array_elements(p_refs) loop
    if jsonb_typeof(v_ref) is distinct from 'object'
       or (select count(*) from jsonb_object_keys(v_ref)) <> 2
       or not (v_ref ? 'sourceId')
       or not (v_ref ? 'versionId')
       or not conuo_private.valid_id(v_ref->>'sourceId')
       or not conuo_private.valid_id(v_ref->>'versionId') then
      raise exception using errcode = '22023', message = 'Invalid source outline reference';
    end if;
    select * into v_row
      from public.source_outlines
      where owner_id = v_owner and source_id = v_ref->>'sourceId' and version_id = v_ref->>'versionId';
    if found then
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'sourceId', v_row.source_id,
        'versionId', v_row.version_id,
        'method', v_row.method,
        'items', v_row.items,
        'updatedAt', v_row.updated_at
      ));
    end if;
  end loop;
  return v_result;
end;
$$;

revoke all on function public.save_source_outline(text,text,text,jsonb),
  public.read_source_outlines(jsonb) from public, anon;
grant execute on function public.save_source_outline(text,text,text,jsonb),
  public.read_source_outlines(jsonb) to authenticated;

commit;
