-- Snapshot-compatible annotation projection. Workspace snapshots remain the sole
-- browser write authority; this table exposes version-bound annotations for later reads.
begin;

create table public.annotations (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  annotation_id text not null check (annotation_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  source_id text not null check (source_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  version_id text not null check (version_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  quote text not null check (octet_length(quote) <= 3145728),
  note text not null check (octet_length(note) <= 3145728),
  page integer check (page between 1 and 100000),
  created_at timestamptz not null,
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  primary key (owner_id, annotation_id)
);

create index annotations_owner_source_version_page
  on public.annotations (owner_id, source_id, version_id, page, created_at desc);

alter table public.annotations enable row level security;
revoke all on table public.annotations from public, anon, authenticated, service_role;
grant select on table public.annotations to authenticated;

create policy "Read own projected annotations" on public.annotations
  for select to authenticated
  using (owner_id = (select auth.uid()) and public.account_deletion_access_allowed());

create function conuo_private.annotation_projection_digest(p_value jsonb)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_value::text, 'UTF8')), 'hex');
$$;

-- A malformed projection aborts the enclosing workspace save. Source/version identities
-- stay denormalized here because source projection runs after workspace triggers and a new
-- workspace may create its source and annotation in the same compare-and-swap.
create function conuo_private.project_annotations_from_workspace(p_owner uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  a jsonb;
  v_annotation_id text;
  v_seen_annotations text[] := '{}';
  v_page integer;
  v_digest text;
begin
  if p_owner is null or p_data is null or jsonb_typeof(p_data) <> 'object'
    or jsonb_typeof(p_data->'annotations') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid annotation workspace';
  end if;
  if jsonb_array_length(p_data->'annotations') > 20000 then
    raise exception using errcode = '22023', message = 'Too many annotations';
  end if;

  for a in select value from jsonb_array_elements(p_data->'annotations') loop
    if jsonb_typeof(a) is distinct from 'object'
      or not conuo_private.valid_id(a->>'id')
      or a->>'id' = any(v_seen_annotations)
      or not conuo_private.valid_id(a->>'sourceId')
      or not conuo_private.valid_id(a->>'versionId')
      or jsonb_typeof(a->'quote') is distinct from 'string'
      or octet_length(a->>'quote') > 3145728
      or jsonb_typeof(a->'note') is distinct from 'string'
      or octet_length(a->>'note') > 3145728
      or not (a ? 'createdAt')
      or jsonb_typeof(a->'createdAt') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Invalid annotation snapshot';
    end if;
    if a ? 'page' then
      if jsonb_typeof(a->'page') is distinct from 'number'
        or a->>'page' !~ '^[1-9][0-9]{0,5}$'
        or (a->>'page')::numeric > 100000 then
        raise exception using errcode = '22023', message = 'Invalid annotation page';
      end if;
      v_page := (a->>'page')::integer;
    else
      v_page := null;
    end if;

    v_annotation_id := a->>'id';
    v_seen_annotations := array_append(v_seen_annotations, v_annotation_id);
    v_digest := conuo_private.annotation_projection_digest(a);

    if exists (
      select 1 from public.annotations existing
      where existing.owner_id = p_owner and existing.annotation_id = v_annotation_id
        and (
          existing.source_id is distinct from a->>'sourceId'
          or existing.version_id is distinct from a->>'versionId'
          or existing.quote is distinct from a->>'quote'
          or existing.page is distinct from v_page
          or existing.created_at is distinct from (a->>'createdAt')::timestamptz
        )
    ) then
      raise exception using errcode = '40001', message = 'Annotation identity changed';
    end if;

    insert into public.annotations (
      owner_id, annotation_id, source_id, version_id, quote, note, page,
      created_at, snapshot_digest
    ) values (
      p_owner, v_annotation_id, a->>'sourceId', a->>'versionId', a->>'quote',
      a->>'note', v_page, (a->>'createdAt')::timestamptz, v_digest
    )
    on conflict (owner_id, annotation_id) do update set
      source_id = excluded.source_id,
      version_id = excluded.version_id,
      quote = excluded.quote,
      note = excluded.note,
      page = excluded.page,
      created_at = excluded.created_at,
      snapshot_digest = excluded.snapshot_digest
    where public.annotations.snapshot_digest is distinct from excluded.snapshot_digest;
  end loop;

  delete from public.annotations annotation_row
    where annotation_row.owner_id = p_owner
      and not (annotation_row.annotation_id = any(v_seen_annotations));
end;
$$;

create function conuo_private.project_annotations_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform conuo_private.project_annotations_from_workspace(new.owner_id, new.data);
  return new;
end;
$$;

create trigger project_workspace_annotations
after insert or update of data on public.workspaces
for each row execute function conuo_private.project_annotations_from_workspace_trigger();

-- Backfill uses the same owner advisory lock as the other snapshot projections. It must
-- include accounts already fenced for deletion so schema state remains internally complete.
do $$
declare w record;
begin
  for w in select owner_id, data from public.workspaces loop
    perform pg_advisory_xact_lock(hashtextextended('conuo:source:' || w.owner_id::text, 0));
    perform conuo_private.project_annotations_from_workspace(w.owner_id, w.data);
  end loop;
end;
$$;

revoke all on function conuo_private.annotation_projection_digest(jsonb),
  conuo_private.project_annotations_from_workspace(uuid,jsonb),
  conuo_private.project_annotations_from_workspace_trigger()
  from public, anon, authenticated, service_role;

comment on table public.annotations is
  'Read projection of version-bound workspaces.data.annotations; workspace snapshots remain the write authority.';
commit;
