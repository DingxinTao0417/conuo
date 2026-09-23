-- Idempotent ink reserve: same operation + bytes must not be blocked by a
-- moved page head. Rejected intents still require a new client operation id.
begin;

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
       or v_intent.preview_sha256<>p_preview_sha256 then
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

revoke all on function public.reserve_ink_upload(text,text,text,integer,uuid,bigint,text,bigint,text,bigint,jsonb,integer) from public, anon;
grant execute on function public.reserve_ink_upload(text,text,text,integer,uuid,bigint,text,bigint,text,bigint,jsonb,integer) to authenticated;

commit;
