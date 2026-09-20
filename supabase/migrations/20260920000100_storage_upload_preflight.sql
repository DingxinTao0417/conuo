-- Supabase Storage checks INSERT permission before persisting an object. This
-- preflight provides metadata.contentLength, whereas the stored object has size.
-- Keep quota accounting/completion on the final size; do not trust absent sizes.
begin;

create or replace function conuo_private.original_upload_storage_insert_allowed(
  p_bucket_id text,
  p_storage_path text,
  p_metadata jsonb
) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_bytes bigint;
begin
  -- If a persisted size is present, it is authoritative even when malformed.
  -- Only the permission probe may fall back to its known HTTP content length.
  if p_metadata ? 'size' then
    v_bytes := conuo_private.storage_object_bytes(p_metadata);
  else
    v_bytes := conuo_private.storage_object_bytes(
      jsonb_build_object('size', p_metadata->'contentLength')
    );
  end if;
  if v_owner is null or p_bucket_id <> 'originals' or v_bytes is null then return false; end if;
  if not public.account_deletion_access_allowed() then return false; end if;
  return exists (
    select 1
      from conuo_private.original_upload_intents intent
      where intent.owner_id = v_owner
        and intent.storage_path = p_storage_path
        and intent.state in ('reserved','uploaded')
        and intent.reservation_until > clock_timestamp()
        and intent.expected_bytes = v_bytes
  );
end;
$$;

revoke all on function conuo_private.original_upload_storage_insert_allowed(text,text,jsonb)
  from public, anon;
grant execute on function conuo_private.original_upload_storage_insert_allowed(text,text,jsonb)
  to authenticated;

commit;
