-- Make JSON array result columns explicit in the source projection.
-- A previously deployed historical definition omitted the aggregate subquery alias,
-- so a workspace save could not resolve sp. Replacing the private projector keeps
-- the source-controlled and deployed definitions aligned without touching workspace data.
begin;

create or replace function conuo_private.project_workspace(p_owner uuid, p_data jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  s jsonb; v jsonb; c jsonb; old_v public.source_versions; manifest jsonb; digest text;
  sid text; vid text; seen_sources text[] := '{}'; seen_versions text[]; seen_chunks text[];
  memberships text[]; tags text[]; chunk_position integer; expected_path text;
  coverage jsonb; page_range jsonb; page_range_start integer; page_range_end integer; previous_page_range_end integer; source_page_count integer;
begin
  if jsonb_typeof(p_data->'sources') is distinct from 'array'
    or jsonb_array_length(p_data->'sources') > 5000
    or jsonb_typeof(p_data->'spaces') is distinct from 'array'
    or jsonb_array_length(p_data->'spaces') > 500
    or (p_data ? 'semanticSearch' and jsonb_typeof(p_data->'semanticSearch') <> 'boolean') then
    raise exception using errcode='22023', message='Invalid retrieval workspace';
  end if;
  if exists (select 1 from jsonb_array_elements(p_data->'spaces') as sp(value)
    where not conuo_private.valid_id(sp.value->>'id') or jsonb_typeof(sp.value->'archived') is distinct from 'boolean')
    or (select count(*) from jsonb_array_elements(p_data->'spaces')) <>
       (select count(distinct sp.value->>'id') from jsonb_array_elements(p_data->'spaces') as sp(value)) then
    raise exception using errcode='22023', message='Invalid library identities';
  end if;
  update public.sources set retained=false where owner_id=p_owner;
  update public.source_versions set retained=false where owner_id=p_owner;
  for s in select value from jsonb_array_elements(p_data->'sources') loop
    sid := s->>'id';
    if not conuo_private.valid_id(sid) or sid=any(seen_sources)
      or not conuo_private.valid_id(s->>'versionId')
      or jsonb_typeof(s->'title') is distinct from 'string' or length(s->>'title')>512
      or jsonb_typeof(s->'spaceIds') is distinct from 'array' or jsonb_array_length(s->'spaceIds')>500
      or jsonb_typeof(s->'tags') is distinct from 'array' or jsonb_array_length(s->'tags')>100
      or jsonb_typeof(s->'aiAllowed') is distinct from 'boolean'
      or not (s ? 'deletedAt') or jsonb_typeof(s->'deletedAt') not in ('string','null')
      or (s ? 'versions' and (jsonb_typeof(s->'versions') <> 'array' or jsonb_array_length(s->'versions')>200)) then
      raise exception using errcode='22023', message='Invalid source identity';
    end if;
    if exists(select 1 from jsonb_array_elements(s->'spaceIds') i where jsonb_typeof(i)<>'string'
      or not conuo_private.valid_id(i #>> '{}'))
      or exists(select 1 from jsonb_array_elements(s->'tags') i where jsonb_typeof(i)<>'string' or length(i #>> '{}')>100) then
      raise exception using errcode='22023', message='Invalid source metadata';
    end if;
    seen_sources := array_append(seen_sources,sid);
    select coalesce(array_agg(value),'{}') into memberships from jsonb_array_elements_text(s->'spaceIds');
    select coalesce(array_agg(value),'{}') into tags from jsonb_array_elements_text(s->'tags');
    insert into public.sources(owner_id,source_id,current_version_id,title,tags,space_ids,ai_allowed,deleted_at)
      values(p_owner,sid,s->>'versionId',s->>'title',tags,memberships,(s->>'aiAllowed')::boolean,(s->>'deletedAt')::timestamptz)
      on conflict (owner_id,source_id) do update set current_version_id=excluded.current_version_id,
        title=excluded.title,tags=excluded.tags,space_ids=excluded.space_ids,
        ai_allowed=excluded.ai_allowed,deleted_at=excluded.deleted_at,retained=true;
    seen_versions := '{}';
    for v in select value from jsonb_array_elements(jsonb_build_array(s) || coalesce(s->'versions','[]'::jsonb)) loop
      vid := v->>'versionId';
      if not conuo_private.valid_id(vid) or vid=any(seen_versions)
        or jsonb_typeof(v->'text') is distinct from 'string'
        or jsonb_typeof(v->'chunks') is distinct from 'array' or jsonb_array_length(v->'chunks')>20000
        or coalesce(v->>'kind','') not in ('pdf','docx','markdown','text','web')
        or ((v->>'kind'='web') is distinct from (s->>'kind'='web'))
        or coalesce(v->>'status','') not in ('saved','parsing','ready','partial','failed','link-only')
        or jsonb_typeof(v->'filename') is distinct from 'string' or length(v->>'filename')>512
        or jsonb_typeof(v->'mime') is distinct from 'string' or length(v->>'mime')>200
        or jsonb_typeof(v->'hash') is distinct from 'string' or length(v->>'hash')>200
        or jsonb_typeof(v->'size') is distinct from 'number' or (v->>'size') !~ '^[0-9]+$'
        or (v->>'size')::numeric>52428800
        or (v ? 'originalMissing' and jsonb_typeof(v->'originalMissing') <> 'boolean') then
        raise exception using errcode='22023', message='Invalid source version';
      end if;
      seen_versions := array_append(seen_versions,vid);
      expected_path := p_owner::text || '/' || vid || '/' || sid || '.' ||
        case v->>'kind' when 'pdf' then 'pdf' when 'docx' then 'docx' when 'markdown' then 'md' when 'text' then 'txt' else 'html' end;
      if (v ? 'storagePath' and (jsonb_typeof(v->'storagePath') <> 'string' or v->>'storagePath' <> expected_path))
        or (v ? 'blobKey' and (jsonb_typeof(v->'blobKey') <> 'string' or length(v->>'blobKey')>512))
        or (v->>'originalMissing'='true' and (v ? 'blobKey' or v ? 'storagePath')) then
        raise exception using errcode='22023', message='Invalid version original identity';
      end if;
      -- Coverage is optional for legacy snapshots. When present it is immutable
      -- version provenance: capture scope must stay distinct from parser gaps.
      if v ? 'coverage' then
        coverage := v->'coverage';
        source_page_count := null;
        if v ? 'pageCount' then
          if jsonb_typeof(v->'pageCount') <> 'number'
            or coalesce(v->>'pageCount','') !~ '^[0-9]+$'
            or (v->>'pageCount')::integer not between 0 and 100000 then
            raise exception using errcode='22023', message='Invalid source page count';
          end if;
          source_page_count := (v->>'pageCount')::integer;
        end if;
        if jsonb_typeof(coverage) <> 'object'
          or exists (select 1 from jsonb_object_keys(coverage) key
                     where key not in ('captureScope','parseState','unavailablePageRanges'))
          or coalesce(coverage->>'captureScope','') not in ('full','selection','manual','link')
          or coalesce(coverage->>'parseState','') not in ('pending','complete','partial','failed','not-requested') then
          raise exception using errcode='22023', message='Invalid source coverage';
        end if;
        if (coverage->>'captureScope'='link' and
            (v->>'kind'<>'web' or coverage->>'parseState'<>'not-requested'
              or v->>'status'<>'link-only' or length(v->>'text')<>0 or jsonb_array_length(v->'chunks')<>0))
          or (coverage->>'captureScope' in ('selection','manual') and
            (v->>'kind'<>'web' or coverage->>'parseState'<>'complete'
              or v->>'status'<>'ready' or length(btrim(v->>'text'))=0 or jsonb_array_length(v->'chunks')=0))
          or (coverage->>'captureScope'='full' and
            ((coverage->>'parseState'='complete' and
                (v->>'status'<>'ready' or length(btrim(v->>'text'))=0 or jsonb_array_length(v->'chunks')=0))
              or (coverage->>'parseState'='partial' and
                (v->>'status'<>'partial' or length(btrim(v->>'text'))=0 or jsonb_array_length(v->'chunks')=0))
              or (coverage->>'parseState'='failed' and v->>'status'<>'failed')
              or (coverage->>'parseState'='pending' and v->>'status' not in ('saved','parsing'))
              or coverage->>'parseState'='not-requested')) then
          raise exception using errcode='22023', message='Inconsistent source coverage';
        end if;
        -- Selection, pasted text and links must carry their matching web capture
        -- scope. Full file coverage may intentionally have no web snapshot.
        if (coverage->>'captureScope'='selection' and
              ((v->'webSnapshot'->>'scope') is distinct from 'selection'))
          or (coverage->>'captureScope'='manual' and
              ((v->'webSnapshot'->>'scope') is distinct from 'pasted'))
          or (coverage->>'captureScope'='link' and
              ((v->'webSnapshot'->>'scope') is distinct from 'link'))
          or ((v->'webSnapshot'->>'scope')='article' and
              (coverage->>'captureScope'<>'full' or coverage->>'parseState'<>'complete'
                or v->>'status'<>'ready'))
          or ((v->'webSnapshot'->>'scope')='selection' and coverage->>'captureScope'<>'selection')
          or ((v->'webSnapshot'->>'scope')='pasted' and coverage->>'captureScope'<>'manual')
          or ((v->'webSnapshot'->>'scope')='link' and coverage->>'captureScope'<>'link') then
          raise exception using errcode='22023', message='Coverage does not match web capture scope';
        end if;
        if coverage ? 'unavailablePageRanges' then
          if jsonb_typeof(coverage->'unavailablePageRanges') <> 'array'
            or jsonb_array_length(coverage->'unavailablePageRanges')=0
            or coverage->>'captureScope'<>'full'
            or coverage->>'parseState' not in ('partial','failed') then
            raise exception using errcode='22023', message='Invalid unavailable page ranges';
          end if;
          previous_page_range_end := null;
          for page_range in select value from jsonb_array_elements(coverage->'unavailablePageRanges') loop
            if jsonb_typeof(page_range) <> 'object'
              or exists (select 1 from jsonb_object_keys(page_range) key where key not in ('start','end'))
              or coalesce(page_range->>'start','') !~ '^[0-9]+$'
              or coalesce(page_range->>'end','') !~ '^[0-9]+$' then
              raise exception using errcode='22023', message='Invalid unavailable page range';
            end if;
            page_range_start := (page_range->>'start')::integer;
            page_range_end := (page_range->>'end')::integer;
            if page_range_start not between 1 and 100000 or page_range_end not between page_range_start and 100000
              or (source_page_count is not null and page_range_end>source_page_count)
              or (previous_page_range_end is not null and page_range_start<=previous_page_range_end) then
              raise exception using errcode='22023', message='Invalid unavailable page range';
            end if;
            previous_page_range_end := page_range_end;
          end loop;
        end if;
      end if;
      -- JSONB normalizes key order; chunk array order and exact locators remain part of the digest.
      manifest := jsonb_build_object('text',v->'text','chunks',v->'chunks','kind',v->'kind',
        'filename',v->'filename','mime',v->'mime','size',v->'size','hash',v->'hash',
        'status',v->'status','pageCount',v->'pageCount','parsedPages',v->'parsedPages',
        'url',v->'url','webSnapshot',v->'webSnapshot');
      if v->>'originalMissing'='true' then
        manifest := manifest || jsonb_build_object('originalMissing',true);
      end if;
      if v ? 'coverage' then
        manifest := manifest || jsonb_build_object('coverage',v->'coverage');
      end if;
      digest := encode(sha256(convert_to(manifest::text,'UTF8')),'hex');
      select * into old_v from public.source_versions where owner_id=p_owner and source_id=sid and version_id=vid;
      if found then
        if old_v.content_digest<>digest or old_v.manifest<>manifest
          or (old_v.blob_key is not null and old_v.blob_key is distinct from v->>'blobKey')
          or (old_v.storage_path is not null and old_v.storage_path is distinct from v->>'storagePath') then
          raise exception using errcode='22023', message='Source version is immutable';
        end if;
        update public.source_versions set retained=true,blob_key=coalesce(blob_key,v->>'blobKey'),
          storage_path=coalesce(storage_path,v->>'storagePath')
          where owner_id=p_owner and source_id=sid and version_id=vid;
      else
        insert into public.source_versions(owner_id,source_id,version_id,manifest,content_digest,text,status,kind,blob_key,storage_path)
          values(p_owner,sid,vid,manifest,digest,v->>'text',v->>'status',v->>'kind',v->>'blobKey',v->>'storagePath');
        chunk_position := 0; seen_chunks := '{}';
        for c in select value from jsonb_array_elements(v->'chunks') loop
          if not conuo_private.valid_id(c->>'id') or c->>'id'=any(seen_chunks)
            or c->>'sourceId' is distinct from sid or c->>'versionId' is distinct from vid
            or jsonb_typeof(c->'text') is distinct from 'string' or length(btrim(c->>'text'))=0
            or position(c->>'text' in v->>'text')=0
            or jsonb_typeof(c->'section') is distinct from 'string' or length(c->>'section')>512
            or coalesce(c->>'order','') !~ '^[0-9]+$' or (c->>'order')::numeric>100000
            or (c ? 'page' and (coalesce(c->>'page','') !~ '^[0-9]+$' or (c->>'page')::numeric not between 1 and 100000)) then
            raise exception using errcode='22023', message='Invalid canonical chunk';
          end if;
          seen_chunks := array_append(seen_chunks,c->>'id');
          insert into public.source_chunks(owner_id,source_id,version_id,chunk_id,position,ordinal,text,section,page,content_hash)
            values(p_owner,sid,vid,c->>'id',chunk_position,(c->>'order')::integer,c->>'text',c->>'section',
              (c->>'page')::integer,encode(sha256(convert_to(c->>'text','UTF8')),'hex'));
          chunk_position := chunk_position+1;
        end loop;
      end if;
    end loop;
  end loop;
  -- Revocation is immediate, including already published vectors. They remain forensic staged data only.
  update public.embedding_jobs j set state='cancelled',cancel_reason='ineligible',
    lease_token=null,lease_until=null,error_code='SOURCE_INELIGIBLE',updated_at=now()
    where j.owner_id=p_owner and not conuo_private.embedding_eligible(j.owner_id,j.source_id,j.version_id)
      and not (j.state='cancelled' and j.cancel_reason='user');
  update public.chunk_embeddings e set published=false from public.embedding_jobs j
    where j.owner_id=p_owner and e.job_id=j.job_id and j.state<>'succeeded' and e.published;
  -- The queue itself is the durable outbox. Future external deliveries carry only job IDs.
  insert into public.embedding_jobs(owner_id,source_id,version_id,content_digest,profile,state,total_chunks)
    select s.owner_id,s.source_id,s.current_version_id,v.content_digest,'embedding-v1','queued',
      (select count(*) from public.source_chunks c where c.owner_id=s.owner_id and c.source_id=s.source_id and c.version_id=s.current_version_id)
    from public.sources s join public.source_versions v on v.owner_id=s.owner_id and v.source_id=s.source_id and v.version_id=s.current_version_id
    where s.owner_id=p_owner and conuo_private.embedding_eligible(s.owner_id,s.source_id,s.current_version_id)
    on conflict (owner_id,source_id,version_id,profile) do update set state='queued',cancel_reason=null,
      error_code=null,attempt=0,next_attempt_at=now(),updated_at=now()
    where public.embedding_jobs.state='cancelled' and public.embedding_jobs.cancel_reason='ineligible';
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
  raise exception using errcode='22023', message='Invalid source projection';
end;
$$;


revoke all on function conuo_private.project_workspace(uuid,jsonb)
  from public, anon, authenticated, service_role;

commit;
