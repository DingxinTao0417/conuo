-- Staging reproduced a hanging response for explicitly raised SQLSTATE 40001.
-- Translate the workspace save boundary only; keep CAS, authorization, and locks.
-- The API accepts both codes so it remains compatible before this migration.
begin;

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
exception when serialization_failure then
  -- Business revision/dependency fences must return promptly through PostgREST.
  -- Preserve rollback of the entire save, including all read projections.
  raise exception using errcode = 'PT409', message = 'Workspace revision conflict';
end;
$$;

revoke all on function public.save_workspace(jsonb,bigint) from public, anon, service_role;
grant execute on function public.save_workspace(jsonb,bigint) to authenticated;

commit;
