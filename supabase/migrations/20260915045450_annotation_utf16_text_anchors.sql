-- Optional source-text anchors use JavaScript UTF-16 offsets, not PostgreSQL
-- character offsets. The workspace snapshot remains the only write authority.
begin;

alter table public.annotations add column text_anchor jsonb;

-- PostgreSQL text contains Unicode scalars. Scan their UTF-8 byte boundaries
-- once: a four-byte scalar occupies two UTF-16 code units; every other scalar
-- occupies one. Neither endpoint may split a surrogate pair. Converting the
-- exact byte span back to text preserves Markdown syntax and all whitespace.
create function conuo_private.annotation_utf16_slice(
  p_text text, p_start bigint, p_end bigint
) returns text language plpgsql immutable strict set search_path = '' as $$
declare
  v_bytes bytea := convert_to(p_text, 'UTF8');
  v_length integer := octet_length(v_bytes);
  v_byte integer := 0;
  v_units bigint := 0;
  v_start_byte integer;
  v_end_byte integer;
  v_first integer;
  v_width integer;
begin
  if p_start < 0 or p_end <= p_start or p_end > v_length then
    raise exception using errcode = '22023', message = 'Invalid annotation text anchor';
  end if;
  while v_byte <= v_length loop
    if v_units = p_start then v_start_byte := v_byte; end if;
    if v_units = p_end then
      v_end_byte := v_byte;
      exit;
    end if;
    if v_byte = v_length or v_units > p_end then exit; end if;
    v_first := get_byte(v_bytes, v_byte);
    v_width := case
      when v_first >= 240 then 4
      when v_first >= 224 then 3
      when v_first >= 192 then 2
      else 1
    end;
    v_byte := v_byte + v_width;
    v_units := v_units + case when v_width = 4 then 2 else 1 end;
  end loop;
  if v_start_byte is null or v_end_byte is null then
    raise exception using errcode = '22023', message = 'Invalid annotation text anchor';
  end if;
  return convert_from(substring(v_bytes from v_start_byte + 1
    for v_end_byte - v_start_byte), 'UTF8');
end;
$$;

create or replace function conuo_private.project_annotations_from_workspace(p_owner uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  a jsonb;
  v_annotation_id text;
  v_seen_annotations text[] := '{}';
  v_page integer;
  v_digest text;
  v_anchor jsonb;
  v_start bigint;
  v_end bigint;
  v_source jsonb;
  v_version jsonb;
  v_source_text text;
  d jsonb;
  v_draft_annotation jsonb;
  v_annotation_matches integer;
begin
  if p_owner is null or p_data is null or jsonb_typeof(p_data) <> 'object'
    or jsonb_typeof(p_data->'annotations') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid annotation workspace';
  end if;
  if jsonb_array_length(p_data->'annotations') > 20000 then
    raise exception using errcode = '22023', message = 'Too many annotations';
  end if;
  if p_data ? 'recoverableDrafts' then
    if jsonb_typeof(p_data->'recoverableDrafts') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'Invalid recoverable draft array';
    end if;
    if jsonb_array_length(p_data->'recoverableDrafts') > 20000 then
      raise exception using errcode = '22023', message = 'Too many recoverable drafts';
    end if;
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

    v_anchor := null;
    if a ? 'textAnchor' then
      v_anchor := a->'textAnchor';
      if jsonb_typeof(v_anchor) is distinct from 'object'
        or not (v_anchor ? 'start' and v_anchor ? 'end')
        or (v_anchor - 'start' - 'end') <> '{}'::jsonb
        or jsonb_typeof(v_anchor->'start') is distinct from 'number'
        or jsonb_typeof(v_anchor->'end') is distinct from 'number'
        or v_anchor->>'start' !~ '^(0|[1-9][0-9]{0,15})$'
        or v_anchor->>'end' !~ '^[1-9][0-9]{0,15}$' then
        raise exception using errcode = '22023', message = 'Invalid annotation text anchor';
      end if;
      v_start := (v_anchor->>'start')::bigint;
      v_end := (v_anchor->>'end')::bigint;
      if v_start > 9007199254740991 or v_end > 9007199254740991
        or v_end <= v_start then
        raise exception using errcode = '22023', message = 'Invalid annotation text anchor';
      end if;
      if jsonb_typeof(p_data->'sources') is distinct from 'array' then
        raise exception using errcode = '22023', message = 'Missing annotation source version';
      end if;
      select source.value into v_source
      from jsonb_array_elements(p_data->'sources') as source(value)
      where source.value->>'id' = a->>'sourceId';
      if v_source is null then
        raise exception using errcode = '22023', message = 'Missing annotation source version';
      end if;
      v_version := v_source;
      if v_source->>'versionId' is distinct from a->>'versionId' then
        if v_source ? 'versions' and jsonb_typeof(v_source->'versions') is distinct from 'array' then
          raise exception using errcode = '22023', message = 'Missing annotation source version';
        end if;
        select version.value into v_version
        from jsonb_array_elements(coalesce(v_source->'versions', '[]'::jsonb)) as version(value)
        where version.value->>'versionId' = a->>'versionId';
      end if;
      if v_version is null or jsonb_typeof(v_version->'text') is distinct from 'string' then
        raise exception using errcode = '22023', message = 'Missing annotation source version';
      end if;
      v_source_text := v_version->>'text';
      if conuo_private.annotation_utf16_slice(v_source_text, v_start, v_end)
        is distinct from a->>'quote' then
        raise exception using errcode = '22023', message = 'Annotation quote does not match text anchor';
      end if;
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
          or existing.text_anchor is distinct from v_anchor
        )
    ) then
      raise exception using errcode = '40001', message = 'Annotation identity changed';
    end if;

    insert into public.annotations (
      owner_id, annotation_id, source_id, version_id, quote, note, page,
      created_at, snapshot_digest, text_anchor
    ) values (
      p_owner, v_annotation_id, a->>'sourceId', a->>'versionId', a->>'quote',
      a->>'note', v_page, (a->>'createdAt')::timestamptz, v_digest, v_anchor
    )
    on conflict (owner_id, annotation_id) do update set
      source_id = excluded.source_id,
      version_id = excluded.version_id,
      quote = excluded.quote,
      note = excluded.note,
      page = excluded.page,
      created_at = excluded.created_at,
      snapshot_digest = excluded.snapshot_digest,
      text_anchor = excluded.text_anchor
    where public.annotations.snapshot_digest is distinct from excluded.snapshot_digest;
  end loop;

  -- Extend the new position contract to detached deletion drafts, without
  -- changing legacy unanchored recovery semantics. Every anchored draft must
  -- copy one already-proven annotation, including anchor presence and value.
  -- This prevents a direct snapshot RPC from storing a moved or orphaned raw
  -- position even when the route's workspace schema was never involved.
  for d in select value from jsonb_array_elements(coalesce(p_data->'recoverableDrafts', '[]'::jsonb)) loop
    if jsonb_typeof(d) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Invalid recoverable draft snapshot';
    end if;
    if d ? 'textAnchor' or exists (
      select 1 from jsonb_array_elements(p_data->'annotations') as candidate(value)
      where candidate.value->>'id' = d->>'annotationId' and candidate.value ? 'textAnchor'
    ) then
      select count(*) into v_annotation_matches
      from jsonb_array_elements(p_data->'annotations') as candidate(value)
      where candidate.value->>'id' = d->>'annotationId';
      if v_annotation_matches <> 1 then
        raise exception using errcode = '22023', message = 'Missing recoverable draft annotation anchor';
      end if;
      select candidate.value into v_draft_annotation
      from jsonb_array_elements(p_data->'annotations') as candidate(value)
      where candidate.value->>'id' = d->>'annotationId';
      if jsonb_typeof(d->'annotationId') is distinct from 'string'
        or d->'sourceId' is distinct from v_draft_annotation->'sourceId'
        or d->'sourceVersionId' is distinct from v_draft_annotation->'versionId'
        or d->'quote' is distinct from v_draft_annotation->'quote'
        or d->'note' is distinct from v_draft_annotation->'note'
        or d->'annotationCreatedAt' is distinct from v_draft_annotation->'createdAt'
        or d->'page' is distinct from v_draft_annotation->'page'
        or (d ? 'textAnchor') is distinct from (v_draft_annotation ? 'textAnchor')
        or d->'textAnchor' is distinct from v_draft_annotation->'textAnchor' then
        raise exception using errcode = '22023', message = 'Recoverable draft annotation anchor changed';
      end if;
    end if;
  end loop;

  delete from public.annotations annotation_row
    where annotation_row.owner_id = p_owner
      and not (annotation_row.annotation_id = any(v_seen_annotations));
end;
$$;

create or replace function conuo_private.project_annotations_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
    and old.data->'annotations' is not distinct from new.data->'annotations'
    and old.data->'recoverableDrafts' is not distinct from new.data->'recoverableDrafts' then
    -- Legacy annotations retain their established compatibility. Anchored ones
    -- also recheck source/version removal, but reading-only updates stay cheap.
    if not exists (select 1 from jsonb_array_elements(new.data->'annotations') as a(value)
      where a.value ? 'textAnchor') then
      return new;
    end if;
    if conuo_private.workspace_retrieval_projection_input(old.data)->'sources'
      is not distinct from conuo_private.workspace_retrieval_projection_input(new.data)->'sources' then
      return new;
    end if;
  end if;
  perform conuo_private.project_annotations_from_workspace(new.owner_id, new.data);
  return new;
end;
$$;

-- Older projection versions accepted this optional JSON field without exposing
-- a column. Initialize it from the authoritative snapshot before identity checks,
-- then validate all rows in the same transaction. Invalid stored anchors abort
-- the migration rather than being silently dropped or assigned a guessed range.
do $$
declare w record;
begin
  for w in select owner_id, data from public.workspaces loop
    perform pg_advisory_xact_lock(hashtextextended('conuo:source:' || w.owner_id::text, 0));
    update public.annotations projected
      set text_anchor = a.value->'textAnchor'
      from jsonb_array_elements(w.data->'annotations') as a(value)
      where projected.owner_id = w.owner_id and projected.annotation_id = a.value->>'id';
    perform conuo_private.project_annotations_from_workspace(w.owner_id, w.data);
  end loop;
end;
$$;

revoke all on function conuo_private.annotation_utf16_slice(text,bigint,bigint),
  conuo_private.project_annotations_from_workspace(uuid,jsonb),
  conuo_private.project_annotations_from_workspace_trigger()
  from public, anon, authenticated, service_role;

comment on column public.annotations.text_anchor is
  'Optional {start,end} half-open UTF-16 offsets into the exact retained Source.text; immutable with annotation identity.';
commit;
