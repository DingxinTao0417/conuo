-- Independent page-level cloud storage for native PencilKit ink.
-- Raw PKDrawing bytes never enter workspaces.data or public.annotations.
begin;

create table public.ink_documents (
  owner_id uuid not null references auth.users(id) on delete cascade,
  ink_document_id uuid not null default gen_random_uuid(),
  source_id text not null check (source_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  version_id text not null check (version_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  format_version integer not null default 1 check (format_version = 1),
  page_count integer not null check (page_count between 1 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, ink_document_id),
  unique (owner_id, source_id, version_id)
);

create table public.ink_page_heads (
  owner_id uuid not null,
  ink_document_id uuid not null,
  page_index integer not null check (page_index between 0 and 99999),
  head_revision_id uuid,
  head_generation bigint not null default 0 check (head_generation >= 0),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, ink_document_id, page_index),
  foreign key (owner_id, ink_document_id)
    references public.ink_documents(owner_id, ink_document_id) on delete cascade
);

create table public.ink_page_revisions (
  owner_id uuid not null,
  revision_id uuid not null,
  ink_document_id uuid not null,
  page_index integer not null check (page_index between 0 and 99999),
  parent_revision_id uuid,
  drawing_storage_path text not null check (drawing_storage_path ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}/[0-9]{1,5}/[a-f0-9-]{36}\.drawing$'),
  drawing_sha256 text not null check (drawing_sha256 ~ '^[a-f0-9]{64}$'),
  drawing_bytes bigint not null check (drawing_bytes between 1 and 8388608),
  preview_storage_path text check (preview_storage_path is null or preview_storage_path ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}/[0-9]{1,5}/[a-f0-9-]{36}\.png$'),
  preview_sha256 text check (preview_sha256 is null or preview_sha256 ~ '^[a-f0-9]{64}$'),
  preview_bytes bigint check (preview_bytes is null or preview_bytes between 1 and 3145728),
  coordinate_space jsonb not null check (coordinate_space = '{"version":1,"space":"pdf-crop-box"}'::jsonb),
  pencilkit_content_version integer not null check (pencilkit_content_version between 1 and 100),
  client_operation_id text not null check (client_operation_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  state text not null default 'committed' check (state = 'committed'),
  created_at timestamptz not null default now(),
  primary key (owner_id, revision_id),
  foreign key (owner_id, ink_document_id)
    references public.ink_documents(owner_id, ink_document_id) on delete cascade,
  unique (owner_id, ink_document_id, page_index, client_operation_id)
);

create table conuo_private.ink_upload_intents (
  intent_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  ink_document_id uuid not null,
  revision_id uuid not null,
  page_index integer not null check (page_index between 0 and 99999),
  base_revision_id uuid,
  client_operation_id text not null check (client_operation_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  local_generation bigint not null check (local_generation > 0),
  drawing_storage_path text not null unique,
  drawing_sha256 text not null check (drawing_sha256 ~ '^[a-f0-9]{64}$'),
  drawing_bytes bigint not null check (drawing_bytes between 1 and 8388608),
  preview_storage_path text not null unique,
  preview_sha256 text not null check (preview_sha256 ~ '^[a-f0-9]{64}$'),
  preview_bytes bigint not null check (preview_bytes between 1 and 3145728),
  coordinate_space jsonb not null check (coordinate_space = '{"version":1,"space":"pdf-crop-box"}'::jsonb),
  pencilkit_content_version integer not null check (pencilkit_content_version between 1 and 100),
  reservation_token uuid not null default gen_random_uuid(),
  state text not null default 'reserved' check (state in ('reserved','uploaded','committed','rejected')),
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  committed_at timestamptz,
  unique (owner_id, client_operation_id),
  foreign key (owner_id, ink_document_id)
    references public.ink_documents(owner_id, ink_document_id) on delete cascade
);

alter table public.ink_documents enable row level security;
alter table public.ink_page_heads enable row level security;
alter table public.ink_page_revisions enable row level security;
revoke all on table public.ink_documents, public.ink_page_heads, public.ink_page_revisions from public, anon, authenticated, service_role;
grant select on table public.ink_documents, public.ink_page_heads, public.ink_page_revisions to authenticated;

create policy "Read own ink documents" on public.ink_documents for select to authenticated
  using (owner_id = (select auth.uid()) and public.account_deletion_access_allowed() and deleted_at is null);
create policy "Read own ink page heads" on public.ink_page_heads for select to authenticated
  using (owner_id = (select auth.uid()) and public.account_deletion_access_allowed());
create policy "Read own ink page revisions" on public.ink_page_revisions for select to authenticated
  using (owner_id = (select auth.uid()) and public.account_deletion_access_allowed() and state = 'committed');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ink', 'ink', false, 8388608, array['application/octet-stream', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = 8388608,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function conuo_private.ink_storage_insert_allowed(
  p_bucket_id text, p_storage_path text, p_metadata jsonb
) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_bytes bigint;
begin
  v_bytes := case
    when p_metadata ? 'size' then conuo_private.storage_object_bytes(p_metadata)
    else conuo_private.storage_object_bytes(
      jsonb_build_object('size', p_metadata->'contentLength')
    )
  end;
  if v_owner is null or p_bucket_id <> 'ink' or v_bytes is null
     or not public.account_deletion_access_allowed() then return false; end if;
  return exists (
    select 1 from conuo_private.ink_upload_intents i
    where i.owner_id = v_owner and i.state = 'reserved'
      and (i.drawing_storage_path = p_storage_path and i.drawing_bytes = v_bytes
           or i.preview_storage_path = p_storage_path and i.preview_bytes = v_bytes)
  );
end;
$$;

drop policy if exists "Read own ink" on storage.objects;
drop policy if exists "Upload reserved ink" on storage.objects;
create policy "Read own ink" on storage.objects for select to authenticated
  using (bucket_id = 'ink' and (storage.foldername(name))[1] = (select auth.uid()::text)
    and public.account_deletion_access_allowed());
create policy "Upload reserved ink" on storage.objects for insert to authenticated
  with check (conuo_private.ink_storage_insert_allowed(bucket_id, name, metadata));

create or replace function public.reserve_ink_upload(
  p_source_id text, p_version_id text, p_operation_id text, p_page_index integer,
  p_base_revision_id uuid, p_local_generation bigint, p_drawing_sha256 text,
  p_drawing_bytes bigint, p_preview_sha256 text, p_preview_bytes bigint,
  p_coordinate_space jsonb, p_pencilkit_content_version integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid(); v_doc public.ink_documents%rowtype;
  v_head public.ink_page_heads%rowtype; v_intent conuo_private.ink_upload_intents%rowtype;
  v_page_count integer; v_revision uuid := gen_random_uuid();
  v_drawing_path text; v_preview_path text;
begin
  if v_owner is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if not conuo_private.valid_id(p_source_id) or not conuo_private.valid_id(p_version_id)
     or not conuo_private.valid_id(p_operation_id) or p_page_index is null
     or p_page_index < 0 or p_local_generation is null or p_local_generation < 1
     or p_drawing_sha256 !~ '^[a-f0-9]{64}$' or p_preview_sha256 !~ '^[a-f0-9]{64}$'
     or p_drawing_bytes not between 1 and 8388608 or p_preview_bytes not between 1 and 3145728
     or p_coordinate_space <> '{"version":1,"space":"pdf-crop-box"}'::jsonb
     or p_pencilkit_content_version not between 1 and 100 then
    raise exception using errcode='22023', message='Invalid ink upload';
  end if;
  perform conuo_private.assert_account_access(v_owner);
  select coalesce(nullif(v.manifest->>'pageCount','')::integer, 0) into v_page_count
    from public.source_versions v join public.sources s using(owner_id, source_id)
    where v.owner_id=v_owner and v.source_id=p_source_id and v.version_id=p_version_id
      and s.deleted_at is null and v.retained and s.retained;
  if v_page_count is null or p_page_index >= v_page_count then
    raise exception using errcode='22023', message='Source version or page is unavailable';
  end if;
  insert into public.ink_documents(owner_id, source_id, version_id, page_count)
    values(v_owner,p_source_id,p_version_id,v_page_count)
    on conflict (owner_id,source_id,version_id) do update set updated_at=now(), deleted_at=null
    returning * into v_doc;
  select * into v_intent from conuo_private.ink_upload_intents
    where owner_id=v_owner and client_operation_id=p_operation_id for update;
  if found then
    if v_intent.page_index<>p_page_index or v_intent.drawing_sha256<>p_drawing_sha256
       or v_intent.preview_sha256<>p_preview_sha256 or v_intent.base_revision_id is distinct from p_base_revision_id then
      raise exception using errcode='PT409', message='Ink operation already differs';
    end if;
    if v_intent.state = 'rejected' then
      raise exception using errcode='PT409', message='Ink operation was rejected';
    end if;
    return jsonb_build_object('status',v_intent.state,'intentId',v_intent.intent_id,
      'revisionId',v_intent.revision_id,'drawingStoragePath',v_intent.drawing_storage_path,
      'previewStoragePath',v_intent.preview_storage_path,'reservationToken',v_intent.reservation_token,
      'baseRevisionId',v_intent.base_revision_id,'pageIndex',v_intent.page_index);
  end if;
  select * into v_head from public.ink_page_heads where owner_id=v_owner
    and ink_document_id=v_doc.ink_document_id and page_index=p_page_index for update;
  if not found then
    insert into public.ink_page_heads(owner_id,ink_document_id,page_index)
      values(v_owner,v_doc.ink_document_id,p_page_index) returning * into v_head;
  end if;
  if v_head.head_revision_id is distinct from p_base_revision_id then
    raise exception using errcode='PT409', message='Ink page revision conflict';
  end if;
  v_drawing_path := v_owner::text || '/' || v_doc.ink_document_id::text || '/' || p_page_index::text || '/' || v_revision::text || '.drawing';
  v_preview_path := v_owner::text || '/' || v_doc.ink_document_id::text || '/' || p_page_index::text || '/' || v_revision::text || '.png';
  insert into conuo_private.ink_upload_intents(
    owner_id,ink_document_id,revision_id,page_index,base_revision_id,client_operation_id,local_generation,
    drawing_storage_path,drawing_sha256,drawing_bytes,preview_storage_path,preview_sha256,preview_bytes,
    coordinate_space,pencilkit_content_version
  ) values(v_owner,v_doc.ink_document_id,v_revision,p_page_index,p_base_revision_id,p_operation_id,p_local_generation,
    v_drawing_path,p_drawing_sha256,p_drawing_bytes,v_preview_path,p_preview_sha256,p_preview_bytes,
    p_coordinate_space,p_pencilkit_content_version) returning * into v_intent;
  return jsonb_build_object('status','reserved','intentId',v_intent.intent_id,'revisionId',v_revision,
    'drawingStoragePath',v_drawing_path,'previewStoragePath',v_preview_path,
    'reservationToken',v_intent.reservation_token,'baseRevisionId',p_base_revision_id,'pageIndex',p_page_index);
end;
$$;

create or replace function public.commit_ink_upload(
  p_intent_id uuid, p_reservation_token uuid, p_operation_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid(); v_intent conuo_private.ink_upload_intents%rowtype;
  v_head public.ink_page_heads%rowtype; v_revision public.ink_page_revisions%rowtype;
  v_drawing_bytes bigint; v_preview_bytes bigint;
begin
  if v_owner is null then raise exception using errcode='42501', message='Authentication required'; end if;
  perform conuo_private.assert_account_access(v_owner);
  select * into v_intent from conuo_private.ink_upload_intents where owner_id=v_owner
    and intent_id=p_intent_id and client_operation_id=p_operation_id for update;
  if not found then raise exception using errcode='22023', message='Ink upload intent unavailable'; end if;
  if v_intent.state='committed' then
    return jsonb_build_object('status','committed','revisionId',v_intent.revision_id,'pageIndex',v_intent.page_index);
  end if;
  if v_intent.reservation_token is distinct from p_reservation_token then
    raise exception using errcode='42501', message='Ink upload reservation is invalid';
  end if;
  select conuo_private.storage_object_bytes(o.metadata) into v_drawing_bytes from storage.objects o
    where o.bucket_id='ink' and o.name=v_intent.drawing_storage_path;
  select conuo_private.storage_object_bytes(o.metadata) into v_preview_bytes from storage.objects o
    where o.bucket_id='ink' and o.name=v_intent.preview_storage_path;
  if v_drawing_bytes is distinct from v_intent.drawing_bytes or v_preview_bytes is distinct from v_intent.preview_bytes then
    raise exception using errcode='PT409', message='Ink bytes are not ready';
  end if;
  select * into v_head from public.ink_page_heads where owner_id=v_owner
    and ink_document_id=v_intent.ink_document_id and page_index=v_intent.page_index for update;
  if v_head.head_revision_id is distinct from v_intent.base_revision_id then
    update conuo_private.ink_upload_intents set state='rejected' where intent_id=v_intent.intent_id;
    raise exception using errcode='PT409', message='Ink page revision conflict';
  end if;
  insert into public.ink_page_revisions(
    owner_id,revision_id,ink_document_id,page_index,parent_revision_id,drawing_storage_path,drawing_sha256,drawing_bytes,
    preview_storage_path,preview_sha256,preview_bytes,coordinate_space,pencilkit_content_version,client_operation_id
  ) values(v_owner,v_intent.revision_id,v_intent.ink_document_id,v_intent.page_index,v_intent.base_revision_id,
    v_intent.drawing_storage_path,v_intent.drawing_sha256,v_intent.drawing_bytes,v_intent.preview_storage_path,
    v_intent.preview_sha256,v_intent.preview_bytes,v_intent.coordinate_space,v_intent.pencilkit_content_version,
    v_intent.client_operation_id) returning * into v_revision;
  update public.ink_page_heads set head_revision_id=v_revision.revision_id,
    head_generation=head_generation+1,updated_at=now(),deleted_at=null
    where owner_id=v_owner and ink_document_id=v_intent.ink_document_id and page_index=v_intent.page_index;
  update public.ink_documents set updated_at=now() where owner_id=v_owner and ink_document_id=v_intent.ink_document_id;
  update conuo_private.ink_upload_intents set state='committed',committed_at=now() where intent_id=v_intent.intent_id;
  return jsonb_build_object('status','committed','revisionId',v_revision.revision_id,'pageIndex',v_revision.page_index,
    'headGeneration',(select head_generation from public.ink_page_heads where owner_id=v_owner and ink_document_id=v_revision.ink_document_id and page_index=v_revision.page_index));
exception when unique_violation then
  select * into v_revision from public.ink_page_revisions where owner_id=v_owner and client_operation_id=p_operation_id;
  if found then return jsonb_build_object('status','committed','revisionId',v_revision.revision_id,'pageIndex',v_revision.page_index); end if;
  raise;
end;
$$;

revoke all on function public.reserve_ink_upload(text,text,text,integer,uuid,bigint,text,bigint,text,bigint,jsonb,integer),
  public.commit_ink_upload(uuid,uuid,text) from public, anon;
grant execute on function public.reserve_ink_upload(text,text,text,integer,uuid,bigint,text,bigint,text,bigint,jsonb,integer),
  public.commit_ink_upload(uuid,uuid,text) to authenticated;

commit;
