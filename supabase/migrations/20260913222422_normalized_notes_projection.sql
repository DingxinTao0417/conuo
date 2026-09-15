-- Snapshot-compatible normalized note projection. Workspace snapshots remain the sole
-- browser write authority; these tables are a transactional read projection for later retrieval.
begin;

create table public.notes (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  note_id text not null check (note_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  space_id text not null check (space_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  title text not null check (char_length(title) <= 512),
  content text not null check (octet_length(content) <= 3145728),
  kind text not null check (kind in ('note','knowledge')),
  -- A missing snapshot field is intentionally retained as NULL. AI eligibility must
  -- continue to require an explicit false rather than treating legacy notes as user-authored.
  ai_generated boolean,
  content_revision bigint check (content_revision between 0 and 9007199254740991),
  status text not null check (status in ('draft','accepted')),
  citations jsonb not null check (jsonb_typeof(citations) = 'array'),
  -- Missing historical/manual reference fields are semantically distinct from an empty array.
  manual_excerpt_refs jsonb check (
    manual_excerpt_refs is null or jsonb_typeof(manual_excerpt_refs) = 'array'
  ),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  primary key (owner_id, note_id)
);

create table public.note_versions (
  owner_id uuid not null,
  note_id text not null,
  version_id text not null check (version_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  -- Ordinal preserves the snapshot's history ordering without making it a writer-owned sequence.
  ordinal integer not null check (ordinal between 0 and 199),
  title text not null check (char_length(title) <= 512),
  content text not null check (octet_length(content) <= 3145728),
  saved_at timestamptz not null,
  citations jsonb check (citations is null or jsonb_typeof(citations) = 'array'),
  status text check (status in ('draft','accepted')),
  ai_generated boolean,
  space_id text check (space_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  content_revision bigint check (content_revision between 0 and 9007199254740991),
  manual_excerpt_refs jsonb check (
    manual_excerpt_refs is null or jsonb_typeof(manual_excerpt_refs) = 'array'
  ),
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  primary key (owner_id, note_id, version_id),
  foreign key (owner_id, note_id) references public.notes(owner_id, note_id) on delete cascade
);

create index notes_owner_live_space_updated_at on public.notes (owner_id, space_id, updated_at desc)
  where deleted_at is null;
create index note_versions_owner_note_ordinal on public.note_versions (owner_id, note_id, ordinal);

alter table public.notes enable row level security;
alter table public.note_versions enable row level security;
revoke all on table public.notes, public.note_versions from public, anon, authenticated, service_role;
grant select on table public.notes, public.note_versions to authenticated;

create policy "Read own projected notes" on public.notes for select to authenticated
  using (owner_id = (select auth.uid()) and public.account_deletion_access_allowed());
create policy "Read own projected note versions" on public.note_versions for select to authenticated
  using (owner_id = (select auth.uid()) and public.account_deletion_access_allowed());

create function conuo_private.note_projection_digest(p_value jsonb)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_value::text, 'UTF8')), 'hex');
$$;

-- This function is deliberately private. It validates the snapshot shape before changing
-- projection rows so a bad write rolls back alongside the workspace compare-and-swap.
create function conuo_private.project_notes_from_workspace(p_owner uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  n jsonb;
  v jsonb;
  v_note_id text;
  v_version_id text;
  v_seen_notes text[] := '{}';
  v_seen_versions text[];
  v_note_digest text;
  v_version_digest text;
  v_ai_generated boolean;
  v_content_revision bigint;
  v_version_ai_generated boolean;
  v_version_content_revision bigint;
  v_manual_excerpt_refs jsonb;
  v_version_manual_excerpt_refs jsonb;
begin
  if p_owner is null or p_data is null or jsonb_typeof(p_data) <> 'object'
    or jsonb_typeof(p_data->'notes') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid note workspace';
  end if;
  if jsonb_array_length(p_data->'notes') > 10000 then
    raise exception using errcode = '22023', message = 'Too many notes';
  end if;

  for n in select value from jsonb_array_elements(p_data->'notes') loop
    if jsonb_typeof(n) is distinct from 'object'
      or not conuo_private.valid_id(n->>'id')
      or n->>'id' = any(v_seen_notes)
      or not conuo_private.valid_id(n->>'spaceId')
      or jsonb_typeof(n->'title') is distinct from 'string'
      or char_length(n->>'title') > 512
      or jsonb_typeof(n->'content') is distinct from 'string'
      or octet_length(n->>'content') > 3145728
      or coalesce(n->>'kind' not in ('note','knowledge'), true)
      or coalesce(n->>'status' not in ('draft','accepted'), true)
      or jsonb_typeof(n->'citations') is distinct from 'array'
      or not (n ? 'versions')
      or jsonb_typeof(n->'versions') is distinct from 'array'
      or not (n ? 'createdAt')
      or jsonb_typeof(n->'createdAt') is distinct from 'string'
      or not (n ? 'updatedAt')
      or jsonb_typeof(n->'updatedAt') is distinct from 'string'
      or not (n ? 'deletedAt')
      or (jsonb_typeof(n->'deletedAt') <> 'string' and jsonb_typeof(n->'deletedAt') <> 'null') then
      raise exception using errcode = '22023', message = 'Invalid note snapshot';
    end if;
    if jsonb_array_length(n->'citations') > 1000 or jsonb_array_length(n->'versions') > 200 then
      raise exception using errcode = '22023', message = 'Note snapshot exceeds limits';
    end if;
    if n ? 'aiGenerated' and jsonb_typeof(n->'aiGenerated') is distinct from 'boolean' then
      raise exception using errcode = '22023', message = 'Invalid note AI flag';
    end if;
    if n ? 'contentRevision' and (
      jsonb_typeof(n->'contentRevision') is distinct from 'number'
      or n->>'contentRevision' !~ '^(0|[1-9][0-9]{0,15})$'
      or (n->>'contentRevision')::numeric > 9007199254740991
    ) then
      raise exception using errcode = '22023', message = 'Invalid note content revision';
    end if;
    if n ? 'manualExcerptRefs' then
      if jsonb_typeof(n->'manualExcerptRefs') is distinct from 'array'
        or jsonb_array_length(n->'manualExcerptRefs') > 1000 then
        raise exception using errcode = '22023', message = 'Invalid note manual excerpt references';
      end if;
    end if;

    v_note_id := n->>'id';
    v_seen_notes := array_append(v_seen_notes, v_note_id);
    v_note_digest := conuo_private.note_projection_digest(n);
    v_ai_generated := case when n ? 'aiGenerated' then (n->>'aiGenerated')::boolean else null end;
    v_content_revision := case
      when n ? 'contentRevision' then (n->>'contentRevision')::bigint else null
    end;
    v_manual_excerpt_refs := case
      when n ? 'manualExcerptRefs' then n->'manualExcerptRefs' else null
    end;

    insert into public.notes (
      owner_id, note_id, space_id, title, content, kind, ai_generated, content_revision,
      status, citations, manual_excerpt_refs, created_at, updated_at, deleted_at, snapshot_digest
    ) values (
      p_owner, v_note_id, n->>'spaceId', n->>'title', n->>'content', n->>'kind',
      v_ai_generated, v_content_revision, n->>'status', n->'citations', v_manual_excerpt_refs,
      (n->>'createdAt')::timestamptz, (n->>'updatedAt')::timestamptz,
      (n->>'deletedAt')::timestamptz, v_note_digest
    )
    on conflict (owner_id, note_id) do update set
      space_id = excluded.space_id,
      title = excluded.title,
      content = excluded.content,
      kind = excluded.kind,
      ai_generated = excluded.ai_generated,
      content_revision = excluded.content_revision,
      status = excluded.status,
      citations = excluded.citations,
      manual_excerpt_refs = excluded.manual_excerpt_refs,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at,
      snapshot_digest = excluded.snapshot_digest
    where public.notes.snapshot_digest is distinct from excluded.snapshot_digest;

    v_seen_versions := '{}';
    for v in
      select value from jsonb_array_elements(n->'versions')
    loop
      if jsonb_typeof(v) is distinct from 'object'
        or not conuo_private.valid_id(v->>'id')
        or v->>'id' = any(v_seen_versions)
        or jsonb_typeof(v->'title') is distinct from 'string'
        or char_length(v->>'title') > 512
        or jsonb_typeof(v->'content') is distinct from 'string'
        or octet_length(v->>'content') > 3145728
        or not (v ? 'savedAt')
        or jsonb_typeof(v->'savedAt') is distinct from 'string' then
        raise exception using errcode = '22023', message = 'Invalid note version snapshot';
      end if;
      if v ? 'citations' then
        if jsonb_typeof(v->'citations') is distinct from 'array'
          or jsonb_array_length(v->'citations') > 1000 then
          raise exception using errcode = '22023', message = 'Invalid note version citations';
        end if;
      end if;
      if v ? 'status' and coalesce(v->>'status' not in ('draft','accepted'), true) then
        raise exception using errcode = '22023', message = 'Invalid note version status';
      end if;
      if v ? 'aiGenerated' and jsonb_typeof(v->'aiGenerated') is distinct from 'boolean' then
        raise exception using errcode = '22023', message = 'Invalid note version AI flag';
      end if;
      if v ? 'spaceId' and not conuo_private.valid_id(v->>'spaceId') then
        raise exception using errcode = '22023', message = 'Invalid note version space';
      end if;
      if v ? 'contentRevision' and (
        jsonb_typeof(v->'contentRevision') is distinct from 'number'
        or v->>'contentRevision' !~ '^(0|[1-9][0-9]{0,15})$'
        or (v->>'contentRevision')::numeric > 9007199254740991
      ) then
        raise exception using errcode = '22023', message = 'Invalid note version content revision';
      end if;
      if v ? 'manualExcerptRefs' then
        if jsonb_typeof(v->'manualExcerptRefs') is distinct from 'array'
          or jsonb_array_length(v->'manualExcerptRefs') > 1000 then
          raise exception using errcode = '22023', message = 'Invalid note version manual excerpt references';
        end if;
      end if;

      v_version_id := v->>'id';
      v_seen_versions := array_append(v_seen_versions, v_version_id);
      v_version_digest := conuo_private.note_projection_digest(v);
      v_version_ai_generated := case when v ? 'aiGenerated' then (v->>'aiGenerated')::boolean else null end;
      v_version_content_revision := case
        when v ? 'contentRevision' then (v->>'contentRevision')::bigint else null
      end;
      v_version_manual_excerpt_refs := case
        when v ? 'manualExcerptRefs' then v->'manualExcerptRefs' else null
      end;

      insert into public.note_versions (
        owner_id, note_id, version_id, ordinal, title, content, saved_at, citations, status,
        ai_generated, space_id, content_revision, manual_excerpt_refs, snapshot_digest
      ) values (
        p_owner, v_note_id, v_version_id, cardinality(v_seen_versions) - 1, v->>'title',
        v->>'content', (v->>'savedAt')::timestamptz,
        case when v ? 'citations' then v->'citations' else null end,
        case when v ? 'status' then v->>'status' else null end,
        v_version_ai_generated,
        case when v ? 'spaceId' then v->>'spaceId' else null end,
        v_version_content_revision, v_version_manual_excerpt_refs, v_version_digest
      )
      on conflict (owner_id, note_id, version_id) do update set
        ordinal = excluded.ordinal,
        title = excluded.title,
        content = excluded.content,
        saved_at = excluded.saved_at,
        citations = excluded.citations,
        status = excluded.status,
        ai_generated = excluded.ai_generated,
        space_id = excluded.space_id,
        content_revision = excluded.content_revision,
        manual_excerpt_refs = excluded.manual_excerpt_refs,
        snapshot_digest = excluded.snapshot_digest
      where public.note_versions.snapshot_digest is distinct from excluded.snapshot_digest
        or public.note_versions.ordinal is distinct from excluded.ordinal;
    end loop;

    delete from public.note_versions version_row
      where version_row.owner_id = p_owner and version_row.note_id = v_note_id
        and not (version_row.version_id = any(v_seen_versions));
  end loop;

  delete from public.notes note_row
    where note_row.owner_id = p_owner and not (note_row.note_id = any(v_seen_notes));
end;
$$;

-- Save workspace and source purge both update public.workspaces. The trigger covers both
-- paths (and future privileged maintenance writes) without adding a second writer protocol.
create function conuo_private.project_notes_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform conuo_private.project_notes_from_workspace(new.owner_id, new.data);
  return new;
end;
$$;

create trigger project_workspace_notes
after insert or update of data on public.workspaces
for each row execute function conuo_private.project_notes_from_workspace_trigger();

-- Existing snapshots are projected using the same validation and transaction boundary.
do $$
declare w record;
begin
  for w in select owner_id, data from public.workspaces loop
    -- This is a schema backfill, so it must also cover accounts already fenced for
    -- deletion. Use the same advisory key without calling owner_lock's access gate.
    perform pg_advisory_xact_lock(hashtextextended('conuo:source:' || w.owner_id::text, 0));
    perform conuo_private.project_notes_from_workspace(w.owner_id, w.data);
  end loop;
end;
$$;

revoke all on function conuo_private.note_projection_digest(jsonb),
  conuo_private.project_notes_from_workspace(uuid,jsonb),
  conuo_private.project_notes_from_workspace_trigger()
  from public, anon, authenticated, service_role;

comment on table public.notes is
  'Read projection of workspaces.data.notes; workspace snapshots remain the write authority.';
comment on table public.note_versions is
  'Read projection of historical note versions ordered exactly as the workspace snapshot.';
commit;
