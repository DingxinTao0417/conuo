-- Keep same-owner workspace writes bounded and avoid rebuilding unrelated read projections.
-- The workspace JSONB snapshot remains the write authority and revision CAS remains unchanged.
begin;

-- Reading progress lives inside source snapshots for compatibility, but none of these three
-- fields participates in the canonical retrieval/source projection. Keep every other source
-- field conservative so future or malformed projection inputs still reach project_workspace.
create function conuo_private.workspace_retrieval_projection_input(p_data jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'sources', case
      when jsonb_typeof(p_data->'sources') = 'array' then coalesce((
        select jsonb_agg(
          case
            when jsonb_typeof(source.value) = 'object' then
              source.value - array['readPage','readOffset','lastReadAt']::text[]
            else source.value
          end
          order by source.ordinality
        )
        from jsonb_array_elements(p_data->'sources') with ordinality as source(value, ordinality)
      ), '[]'::jsonb)
      else p_data->'sources'
    end,
    'spaces', p_data->'spaces',
    'aiEnabled', p_data->'aiEnabled',
    -- Missing semanticSearch is a valid legacy state while explicit JSON null is invalid.
    -- Preserve key presence so the comparison cannot skip project_workspace validation.
    'semanticSearchPresent', p_data ? 'semanticSearch',
    'semanticSearch', p_data->'semanticSearch'
  );
$$;

-- Every blocking owner-lock caller (parse transitions, source purges, and worker
-- lease operations) needs the same post-lock deletion fence as the fast save path.
-- A request may pass the first check, wait behind prepare_account_deletion, then
-- acquire this key only after the deletion record commits.
create or replace function conuo_private.owner_lock(p_owner uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform conuo_private.assert_account_access(p_owner);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('conuo:source:' || p_owner::text, 0)
  );
  perform conuo_private.assert_account_access(p_owner);
end;
$$;

create or replace function conuo_private.project_notes_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if old.data->'notes' is not distinct from new.data->'notes' then
      return new;
    end if;
  end if;
  perform conuo_private.project_notes_from_workspace(new.owner_id, new.data);
  return new;
end;
$$;

create or replace function conuo_private.project_conversations_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if old.data->'conversations' is not distinct from new.data->'conversations' then
      return new;
    end if;
  end if;
  perform conuo_private.project_conversations_from_workspace(new.owner_id, new.data);
  return new;
end;
$$;

create or replace function conuo_private.project_annotations_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if old.data->'annotations' is not distinct from new.data->'annotations' then
      return new;
    end if;
  end if;
  perform conuo_private.project_annotations_from_workspace(new.owner_id, new.data);
  return new;
end;
$$;

create or replace function conuo_private.project_concept_relations_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if old.data->'conceptRelations' is not distinct from new.data->'conceptRelations' then
      return new;
    end if;
  end if;
  perform conuo_private.project_concept_relations_from_workspace(new.owner_id, new.data);
  return new;
end;
$$;

create or replace function conuo_private.project_learning_spaces_from_workspace_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if old.data->'spaces' is not distinct from new.data->'spaces' then
      return new;
    end if;
  end if;
  perform conuo_private.project_learning_spaces_from_workspace(new.owner_id, new.data);
  return new;
end;
$$;

create or replace function public.save_workspace(p_data jsonb, p_expected_revision bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_workspace public.workspaces%rowtype;
  v_revision bigint;
  v_project_workspace boolean := true;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_expected_revision is null or p_expected_revision < 0
    or p_data is null
    or jsonb_typeof(p_data) <> 'object'
    or p_data->>'schemaVersion' is distinct from '1'
    or jsonb_typeof(p_data->'spaces') is distinct from 'array'
    or jsonb_typeof(p_data->'sources') is distinct from 'array'
    or jsonb_typeof(p_data->'notes') is distinct from 'array'
    or jsonb_typeof(p_data->'annotations') is distinct from 'array'
    or jsonb_typeof(p_data->'conversations') is distinct from 'array'
    or jsonb_typeof(p_data->'aiEnabled') is distinct from 'boolean'
    or octet_length(p_data::text) > 3145728 then
    raise exception using errcode = '22023', message = 'Invalid workspace payload';
  end if;

  perform conuo_private.assert_account_access(v_owner);
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('conuo:source:' || v_owner::text, 0)
  ) then
    raise exception using errcode = '55P03', message = 'Workspace write busy';
  end if;

  -- Account deletion uses the same owner lock. Recheck after serialization so a
  -- deletion committed between the first access check and this lock cannot race a save.
  perform conuo_private.assert_account_access(v_owner);

  perform conuo_private.validate_workspace_payload(v_owner, p_data);
  select * into v_workspace from public.workspaces workspace
    where workspace.owner_id = v_owner for update;

  if p_expected_revision = 0 then
    if found then
      raise exception using errcode = '40001', message = 'Workspace revision conflict';
    end if;
    insert into public.workspaces(owner_id, data, revision)
      values (v_owner, p_data, 1)
      returning revision into v_revision;
  else
    if not found or v_workspace.revision <> p_expected_revision then
      raise exception using errcode = '40001', message = 'Workspace revision conflict';
    end if;
    perform conuo_private.assert_import_parse_leases_unchanged(
      v_owner, v_workspace.data, p_data
    );
    v_project_workspace :=
      conuo_private.workspace_retrieval_projection_input(v_workspace.data)
      is distinct from
      conuo_private.workspace_retrieval_projection_input(p_data);
    update public.workspaces workspace
      set data = p_data, revision = workspace.revision + 1, updated_at = now()
      where workspace.owner_id = v_owner and workspace.revision = p_expected_revision
      returning workspace.revision into v_revision;
  end if;

  if v_revision is null then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  if v_project_workspace then
    perform conuo_private.project_workspace(v_owner, p_data);
  end if;
  return v_revision;
end;
$$;

revoke all on function conuo_private.workspace_retrieval_projection_input(jsonb),
  conuo_private.owner_lock(uuid),
  conuo_private.project_notes_from_workspace_trigger(),
  conuo_private.project_conversations_from_workspace_trigger(),
  conuo_private.project_annotations_from_workspace_trigger(),
  conuo_private.project_concept_relations_from_workspace_trigger(),
  conuo_private.project_learning_spaces_from_workspace_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.save_workspace(jsonb,bigint) from public, anon, service_role;
grant execute on function public.save_workspace(jsonb,bigint) to authenticated;

commit;
