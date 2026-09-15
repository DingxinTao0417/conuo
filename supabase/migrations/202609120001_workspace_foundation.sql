-- First local development increment: owner-isolated workspace snapshots.
-- This is not the final normalized source/chunk/pgvector schema.
begin;

create table public.workspaces (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  constraint workspace_object check (jsonb_typeof(data) = 'object'),
  constraint workspace_size check (octet_length(data::text) <= 3145728)
);

alter table public.workspaces enable row level security;
create policy "Read own workspace" on public.workspaces
  for select to authenticated using (owner_id = (select auth.uid()));

-- Direct writes are disallowed. The RPC below is the only authenticated writer,
-- guaranteeing compare-and-swap even when clients call the Data API directly.
revoke all on table public.workspaces from anon, authenticated;
grant select on table public.workspaces to authenticated;

create function public.save_workspace(p_data jsonb, p_expected_revision bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_revision bigint;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_expected_revision is null or p_expected_revision < 0
     or p_data is null or jsonb_typeof(p_data) <> 'object'
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
  if exists (
    select 1 from jsonb_array_elements(p_data->'sources') as source(value)
    where source.value ? 'storagePath'
      and source.value->>'storagePath' not like v_owner::text || '/%'
  ) then
    raise exception using errcode = '22023', message = 'Invalid storage owner';
  end if;

  if p_expected_revision = 0 then
    insert into public.workspaces(owner_id, data, revision)
    values (v_owner, p_data, 1)
    on conflict (owner_id) do nothing
    returning revision into v_revision;
  else
    update public.workspaces
      set data = p_data, revision = revision + 1, updated_at = now()
      where owner_id = v_owner and revision = p_expected_revision
      returning revision into v_revision;
  end if;

  if v_revision is null then
    raise exception using errcode = '40001', message = 'Workspace revision conflict';
  end if;
  return v_revision;
end;
$$;

revoke all on function public.save_workspace(jsonb, bigint) from public, anon;
grant execute on function public.save_workspace(jsonb, bigint) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'originals', 'originals', false, 52428800,
  array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown', 'text/x-markdown', 'text/html', 'application/octet-stream']
);

-- Each immutable object path starts with auth.uid(), then a source version.
-- No UPDATE policy is granted: replacements must create a new version path.
create policy "Read own originals" on storage.objects
  for select to authenticated
  using (bucket_id = 'originals' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "Upload own originals" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'originals' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "Delete own originals" on storage.objects
  for delete to authenticated
  using (bucket_id = 'originals' and (storage.foldername(name))[1] = (select auth.uid()::text));

commit;
