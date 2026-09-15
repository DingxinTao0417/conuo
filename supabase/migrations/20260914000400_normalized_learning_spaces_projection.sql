-- Snapshot-compatible learning-space projection. Workspace snapshots remain the sole
-- browser write authority; this table preserves the ordered knowledge-library shelf.
begin;

create table public.learning_spaces (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  space_id text not null check (space_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  ordinal integer not null check (ordinal between 0 and 499),
  name text not null check (char_length(name) between 1 and 512 and btrim(name) <> ''),
  goal text not null check (char_length(goal) <= 10000),
  color text not null check (char_length(color) <= 100),
  archived boolean not null,
  created_at timestamptz not null,
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  primary key (owner_id, space_id),
  check (space_id not in ('all','inbox'))
);

create index learning_spaces_owner_ordinal
  on public.learning_spaces (owner_id, ordinal);
create index learning_spaces_owner_active_ordinal
  on public.learning_spaces (owner_id, ordinal)
  where archived = false;
create index learning_spaces_owner_archived_created_at
  on public.learning_spaces (owner_id, archived, created_at desc);

alter table public.learning_spaces enable row level security;
revoke all on table public.learning_spaces from public, anon, authenticated, service_role;
grant select on table public.learning_spaces to authenticated;

create policy "Read own projected learning spaces" on public.learning_spaces
  for select to authenticated
  using (owner_id = (select auth.uid()) and public.account_deletion_access_allowed());

create function conuo_private.learning_space_projection_digest(
  p_value jsonb,
  p_ordinal integer
) returns text language sql immutable set search_path = '' as $$
  select encode(
    sha256(convert_to(jsonb_build_object('ordinal',p_ordinal,'space',p_value)::text, 'UTF8')),
    'hex'
  );
$$;

-- This private projector validates the complete array before the transaction commits.
-- Any malformed or duplicate space rolls back the workspace compare-and-swap as well.
create function conuo_private.project_learning_spaces_from_workspace(
  p_owner uuid,
  p_data jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  space_snapshot jsonb;
  v_space_id text;
  v_ordinal integer;
  v_seen_spaces text[] := '{}';
  v_digest text;
  v_existing public.learning_spaces%rowtype;
begin
  if p_owner is null or p_data is null or jsonb_typeof(p_data) <> 'object'
    or jsonb_typeof(p_data->'spaces') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid learning space workspace';
  end if;
  if jsonb_array_length(p_data->'spaces') > 500 then
    raise exception using errcode = '22023', message = 'Too many learning spaces';
  end if;

  for space_snapshot in select value from jsonb_array_elements(p_data->'spaces') loop
    if jsonb_typeof(space_snapshot) is distinct from 'object'
      or not conuo_private.valid_id(space_snapshot->>'id')
      or space_snapshot->>'id' in ('all','inbox')
      or space_snapshot->>'id' = any(v_seen_spaces)
      or jsonb_typeof(space_snapshot->'name') is distinct from 'string'
      or char_length(space_snapshot->>'name') > 512
      or btrim(space_snapshot->>'name') = ''
      or jsonb_typeof(space_snapshot->'goal') is distinct from 'string'
      or char_length(space_snapshot->>'goal') > 10000
      or jsonb_typeof(space_snapshot->'color') is distinct from 'string'
      or char_length(space_snapshot->>'color') > 100
      or jsonb_typeof(space_snapshot->'archived') is distinct from 'boolean'
      or jsonb_typeof(space_snapshot->'createdAt') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Invalid learning space snapshot';
    end if;

    v_space_id := space_snapshot->>'id';
    v_ordinal := cardinality(v_seen_spaces);
    v_seen_spaces := array_append(v_seen_spaces, v_space_id);
    v_digest := conuo_private.learning_space_projection_digest(space_snapshot, v_ordinal);

    select * into v_existing from public.learning_spaces existing
      where existing.owner_id = p_owner and existing.space_id = v_space_id;
    if found and (space_snapshot->>'createdAt')::timestamptz
      is distinct from v_existing.created_at then
      raise exception using errcode = '22023', message = 'Learning space identity changed';
    end if;

    insert into public.learning_spaces (
      owner_id, space_id, ordinal, name, goal, color, archived, created_at, snapshot_digest
    ) values (
      p_owner, v_space_id, v_ordinal, space_snapshot->>'name', space_snapshot->>'goal',
      space_snapshot->>'color', (space_snapshot->>'archived')::boolean,
      (space_snapshot->>'createdAt')::timestamptz, v_digest
    )
    on conflict (owner_id, space_id) do update set
      ordinal = excluded.ordinal,
      name = excluded.name,
      goal = excluded.goal,
      color = excluded.color,
      archived = excluded.archived,
      created_at = excluded.created_at,
      snapshot_digest = excluded.snapshot_digest
    where public.learning_spaces.snapshot_digest is distinct from excluded.snapshot_digest;
  end loop;

  delete from public.learning_spaces space_row
    where space_row.owner_id = p_owner
      and not (space_row.space_id = any(v_seen_spaces));
end;
$$;

create function conuo_private.project_learning_spaces_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform conuo_private.project_learning_spaces_from_workspace(new.owner_id, new.data);
  return new;
end;
$$;

create trigger project_workspace_learning_spaces
after insert or update of data on public.workspaces
for each row execute function conuo_private.project_learning_spaces_from_workspace_trigger();

do $$
declare w record;
begin
  for w in select owner_id, data from public.workspaces loop
    perform pg_advisory_xact_lock(hashtextextended('conuo:source:' || w.owner_id::text, 0));
    perform conuo_private.project_learning_spaces_from_workspace(w.owner_id, w.data);
  end loop;
end;
$$;

revoke all on function conuo_private.learning_space_projection_digest(jsonb,integer),
  conuo_private.project_learning_spaces_from_workspace(uuid,jsonb),
  conuo_private.project_learning_spaces_from_workspace_trigger()
  from public, anon, authenticated, service_role;

comment on table public.learning_spaces is
  'Ordered read projection of workspaces.data.spaces for the knowledge-library shelf.';
commit;
