-- Canonical retained versions, lexical retrieval, and a durable embedding outbox/lease queue.
-- The workspace snapshot remains the client/CAS protocol. Projection and queue changes are atomic.
begin;

create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create schema if not exists conuo_private;
revoke all on schema conuo_private from public, anon, authenticated, service_role;

create table public.sources (
  owner_id uuid not null references public.workspaces(owner_id) on delete cascade,
  source_id text not null check (source_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  current_version_id text not null check (current_version_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  title text not null,
  tags text[] not null default '{}',
  space_ids text[] not null default '{}',
  ai_allowed boolean not null,
  deleted_at timestamptz,
  retained boolean not null default true,
  primary key (owner_id, source_id)
);

create table public.source_versions (
  owner_id uuid not null,
  source_id text not null,
  version_id text not null check (version_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  -- Title and other mutable identity metadata are intentionally excluded from this manifest.
  manifest jsonb not null,
  content_digest text not null check (content_digest ~ '^[a-f0-9]{64}$'),
  text text not null,
  status text not null check (status in ('saved','parsing','ready','partial','failed','link-only')),
  kind text not null check (kind in ('pdf','docx','markdown','text','web')),
  blob_key text,
  storage_path text,
  retained boolean not null default true,
  primary key (owner_id, source_id, version_id),
  foreign key (owner_id, source_id) references public.sources on delete cascade
);
alter table public.sources add constraint source_current_version
  foreign key (owner_id, source_id, current_version_id) references public.source_versions
  deferrable initially deferred;

create table public.source_chunks (
  owner_id uuid not null,
  source_id text not null,
  version_id text not null,
  chunk_id text not null check (chunk_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  position integer not null check (position >= 0),
  ordinal integer not null check (ordinal between 0 and 100000),
  text text not null,
  section text not null,
  page integer check (page between 1 and 100000),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  -- Bound the derived tsvector, whose own PostgreSQL limit is 1 MiB. Canonical text remains whole;
  -- lexical RPCs also check content terms against the complete body, including the unindexed tail.
  search_document tsvector generated always as (to_tsvector('simple'::regconfig, left(text,100000))) stored,
  primary key (owner_id, source_id, version_id, chunk_id),
  unique (owner_id, source_id, version_id, position),
  foreign key (owner_id, source_id, version_id) references public.source_versions on delete cascade
);
create index source_chunks_lexical on public.source_chunks using gin (search_document);
create index sources_membership on public.sources using gin (space_ids);

create table public.embedding_profiles (
  profile text primary key check (profile = 'embedding-v1'),
  dimensions integer not null check (dimensions = 1536),
  fingerprint text check (fingerprint ~ '^[a-f0-9]{64}$')
);
insert into public.embedding_profiles values ('embedding-v1', 1536, null);

create table public.embedding_jobs (
  job_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  source_id text not null,
  version_id text not null,
  content_digest text not null,
  profile text not null references public.embedding_profiles,
  state text not null check (state in ('queued','running','succeeded','failed','cancelled')),
  generation integer not null default 1 check (generation > 0),
  cursor integer not null default 0 check (cursor >= 0),
  total_chunks integer not null check (total_chunks > 0),
  attempt integer not null default 0 check (attempt between 0 and 5),
  worker_id text,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  error_code text,
  cancel_reason text check (cancel_reason in ('user','ineligible')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, source_id, version_id, profile),
  foreign key (owner_id, source_id, version_id) references public.source_versions on delete cascade,
  check (cursor <= total_chunks)
);
create index embedding_jobs_dispatch on public.embedding_jobs (next_attempt_at, created_at)
  where state in ('queued','running');

create table public.chunk_embeddings (
  job_id uuid not null references public.embedding_jobs on delete cascade,
  generation integer not null,
  owner_id uuid not null,
  source_id text not null,
  version_id text not null,
  chunk_id text not null,
  content_hash text not null,
  embedding extensions.vector(1536) not null,
  published boolean not null default false,
  primary key (job_id, generation, chunk_id),
  foreign key (owner_id, source_id, version_id, chunk_id) references public.source_chunks on delete cascade
);
create index chunk_embeddings_cosine on public.chunk_embeddings
  using hnsw (embedding extensions.vector_cosine_ops) where published;

create table public.embedding_usage (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (request_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  usage_date date not null,
  characters integer not null check (characters between 1 and 200000),
  created_at timestamptz not null default now(),
  primary key (owner_id, request_id)
);
create index embedding_usage_day on public.embedding_usage (owner_id, usage_date);

-- No caller, including the worker, writes canonical tables directly. All operations use fenced RPCs.
do $$
declare t text;
begin
  foreach t in array array['sources','source_versions','source_chunks','embedding_profiles',
    'embedding_jobs','chunk_embeddings','embedding_usage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

create function conuo_private.owner_lock(p_owner uuid) returns void
language sql set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('conuo:source:' || p_owner::text, 0));
$$;

create function conuo_private.valid_id(p_value text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_value ~ '^[a-zA-Z0-9_-]{1,100}$', false);
$$;

create function conuo_private.in_scope(p_spaces jsonb, p_memberships text[], p_scope text)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when p_scope = 'inbox' then cardinality(p_memberships) = 0
    when p_scope = '*' then cardinality(p_memberships) = 0 or exists (
      select 1 from jsonb_array_elements(p_spaces) s
      where s->>'id' = any(p_memberships) and s->>'archived' = 'false')
    else p_scope = any(p_memberships) and exists (
      select 1 from jsonb_array_elements(p_spaces) s
      where s->>'id' = p_scope and s->>'archived' = 'false') end;
$$;

create function conuo_private.embedding_eligible(p_owner uuid, p_source text, p_version text)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.sources s
    join public.workspaces w on w.owner_id = s.owner_id
    join public.source_versions v on v.owner_id=s.owner_id and v.source_id=s.source_id
      and v.version_id=s.current_version_id
    where s.owner_id=p_owner and s.source_id=p_source and s.current_version_id=p_version
      and s.retained and v.retained and s.deleted_at is null and s.ai_allowed
      and w.data->>'aiEnabled'='true' and w.data->>'semanticSearch'='true'
      and v.status in ('ready','partial')
      and conuo_private.in_scope(w.data->'spaces',s.space_ids,'*')
      and exists (select 1 from public.source_chunks c where c.owner_id=s.owner_id
        and c.source_id=s.source_id and c.version_id=s.current_version_id)
  );
$$;

-- Called only by save_workspace and this migration's backfill. Never a public RPC.
create function conuo_private.project_workspace(p_owner uuid, p_data jsonb) returns void
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
  if exists (select 1 from jsonb_array_elements(p_data->'spaces') sp
    where not conuo_private.valid_id(sp->>'id') or jsonb_typeof(sp->'archived') is distinct from 'boolean')
    or (select count(*) from jsonb_array_elements(p_data->'spaces')) <>
       (select count(distinct sp->>'id') from jsonb_array_elements(p_data->'spaces') sp) then
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

create or replace function public.save_workspace(p_data jsonb, p_expected_revision bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_revision bigint;
begin
  if v_owner is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_expected_revision is null or p_expected_revision<0 or p_data is null
    or jsonb_typeof(p_data)<>'object' or p_data->>'schemaVersion' is distinct from '1'
    or jsonb_typeof(p_data->'spaces') is distinct from 'array'
    or jsonb_typeof(p_data->'sources') is distinct from 'array'
    or jsonb_typeof(p_data->'notes') is distinct from 'array'
    or jsonb_typeof(p_data->'annotations') is distinct from 'array'
    or jsonb_typeof(p_data->'conversations') is distinct from 'array'
    or jsonb_typeof(p_data->'aiEnabled') is distinct from 'boolean'
    or octet_length(p_data::text)>3145728 then
    raise exception using errcode='22023', message='Invalid workspace payload';
  end if;
  perform conuo_private.owner_lock(v_owner);
  if p_expected_revision=0 then
    insert into public.workspaces(owner_id,data,revision) values(v_owner,p_data,1)
      on conflict (owner_id) do nothing returning revision into v_revision;
  else
    update public.workspaces set data=p_data,revision=revision+1,updated_at=now()
      where owner_id=v_owner and revision=p_expected_revision returning revision into v_revision;
  end if;
  if v_revision is null then raise exception using errcode='40001', message='Workspace revision conflict'; end if;
  perform conuo_private.project_workspace(v_owner,p_data);
  return v_revision;
end;
$$;

create function conuo_private.validate_search(p_owner uuid,p_scope text,p_source_ids text[],p_limit integer)
returns void language plpgsql stable set search_path = '' as $$
begin
  if p_owner is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_scope is null or (p_scope<>'*' and not conuo_private.valid_id(p_scope))
    or p_limit is null or p_limit not between 1 and 100
    or (p_source_ids is not null and (cardinality(p_source_ids)>5000 or exists
      (select 1 from unnest(p_source_ids) s where not conuo_private.valid_id(s)))) then
    raise exception using errcode='22023', message='Invalid retrieval scope';
  end if;
  if p_scope not in ('*','inbox') and not exists (select 1 from public.workspaces w,
    jsonb_array_elements(w.data->'spaces') s where w.owner_id=p_owner and s->>'id'=p_scope and s->>'archived'='false') then
    raise exception using errcode='22023', message='Library unavailable';
  end if;
end;
$$;

create function public.search_source_chunks(p_query text,p_space_id text,p_source_ids text[] default null,
  p_for_ai boolean default false,p_limit integer default 20)
returns table(source_id text,version_id text,chunk_id text,title text,text text,section text,page integer,
  ordinal integer,score double precision,coverage_status text,workspace_revision bigint)
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); q tsquery; english_terms text[]; cjk_terms text[]; min_cjk integer;
begin
  perform conuo_private.validate_search(v_owner,p_space_id,p_source_ids,p_limit);
  if p_query is null or length(btrim(p_query))=0 or length(p_query)>4000 or p_for_ai is null then
    raise exception using errcode='22023', message='Invalid search query';
  end if;
  -- Deterministic fallback, not Chinese linguistic segmentation: adjacent Han-character pairs
  -- recover topic words inside natural-language questions. English content words use OR matching.
  select coalesce(array_agg(term),'{}') into english_terms from (
    select distinct lower(m[1]) as term from regexp_matches(p_query,'[A-Za-z0-9_]{2,}','g') m
    where lower(m[1]) <> all(array['a','an','the','and','or','of','to','in','on','at','for','with',
      'is','are','was','were','be','been','being','do','does','did','what','which','why','how',
      'can','could','would','should','will','it','its','this','that','these','those','me','my','i',
      'tell','please','about','when','where','who','too']) order by term limit 128
  ) terms;
  select coalesce(array_agg(term),'{}') into cjk_terms from (
    select distinct substring(m[1] from n for 2) as term
    from regexp_matches(p_query,'[一-鿿]+','g') m,
      lateral generate_series(1,length(m[1])-1) n
    where substring(m[1] from n for 2) <> all(array['什么','为什','为何','如何','怎样','怎么',
      '会怎','么样','是否','一个','这个','那个','哪些','一下','可以','能够','有关','关于'])
    order by term limit 256
  ) terms;
  min_cjk := least(2,cardinality(cjk_terms));
  q := case when cardinality(english_terms)>0 then
      to_tsquery('simple'::regconfig,array_to_string(english_terms,' | '))
    else plainto_tsquery('simple'::regconfig,p_query) end;
  return query with hits as (
    select c.source_id,c.version_id,c.chunk_id,s.title,c.text,c.section,c.page,c.ordinal,
      (ts_rank_cd(c.search_document,q)::double precision + matches.chinese_hits*0.2 + matches.english_hits*0.1 +
        case when strpos(lower(c.text),lower(btrim(p_query)))>0 then 1.0 else 0 end +
        case when matches.metadata_match then 0.5 else 0 end) as rank_score,
      v.status,w.revision,c.position
    from public.source_chunks c
    join public.sources s on s.owner_id=c.owner_id and s.source_id=c.source_id and s.current_version_id=c.version_id
    join public.source_versions v on v.owner_id=c.owner_id and v.source_id=c.source_id and v.version_id=c.version_id
    join public.workspaces w on w.owner_id=c.owner_id
    cross join lateral (select
      (select count(*) from unnest(cjk_terms) term where strpos(c.text,term)>0) as chinese_hits,
      (select count(*) from unnest(english_terms) term where c.text ~* ('\m' || term || '\M')) as english_hits,
      (strpos(lower(s.title || ' ' || array_to_string(s.tags,' ')),lower(btrim(p_query)))>0
        or to_tsvector('simple'::regconfig,s.title || ' ' || array_to_string(s.tags,' ')) @@ q
        or (min_cjk>0 and (select count(*) from unnest(cjk_terms) term
          where strpos(s.title || ' ' || array_to_string(s.tags,' '),term)>0)>=min_cjk)) as metadata_match
    ) matches
    where c.owner_id=v_owner and s.retained and v.retained and s.deleted_at is null
      and v.status in ('ready','partial')
      and ((p_space_id='*' and not p_for_ai) or conuo_private.in_scope(w.data->'spaces',s.space_ids,p_space_id))
      and (p_source_ids is null or c.source_id=any(p_source_ids))
      and (not p_for_ai or (s.ai_allowed and w.data->>'aiEnabled'='true'))
      and (c.search_document @@ q or strpos(lower(c.text),lower(btrim(p_query)))>0
        or matches.english_hits>0 or (min_cjk>0 and matches.chinese_hits>=min_cjk) or matches.metadata_match)
    union all
    select s.source_id,s.current_version_id,null::text,s.title,null::text,null::text,null::integer,null::integer,
      0.5::double precision,v.status,w.revision,0
    from public.sources s join public.source_versions v on v.owner_id=s.owner_id
      and v.source_id=s.source_id and v.version_id=s.current_version_id
    join public.workspaces w on w.owner_id=s.owner_id
    where not p_for_ai and s.owner_id=v_owner and s.retained and v.retained and s.deleted_at is null
      and (p_space_id='*' or conuo_private.in_scope(w.data->'spaces',s.space_ids,p_space_id))
      and (p_source_ids is null or s.source_id=any(p_source_ids))
      and (strpos(lower(s.title || ' ' || array_to_string(s.tags,' ')),lower(btrim(p_query)))>0
        or to_tsvector('simple'::regconfig,s.title || ' ' || array_to_string(s.tags,' ')) @@ q
        or (min_cjk>0 and (select count(*) from unnest(cjk_terms) term
          where strpos(s.title || ' ' || array_to_string(s.tags,' '),term)>0)>=min_cjk))
      and not exists(select 1 from public.source_chunks c where c.owner_id=s.owner_id
        and c.source_id=s.source_id and c.version_id=s.current_version_id and v.status in ('ready','partial'))
  ), ranked as (
    select h.*,row_number() over (partition by h.source_id order by h.rank_score desc,h.position) as source_rank
    from hits h
  ) select h.source_id,h.version_id,h.chunk_id,h.title,h.text,h.section,h.page,h.ordinal,
      h.rank_score,h.status,h.revision from ranked h where p_for_ai or h.source_rank=1
    order by h.rank_score desc,h.source_id,h.position limit p_limit;
end;
$$;

create function conuo_private.parse_embedding(p_value jsonb) returns extensions.vector
language plpgsql immutable set search_path = '' as $$
declare v extensions.vector;
begin
  if jsonb_typeof(p_value) is distinct from 'array' or jsonb_array_length(p_value)<>1536
    or exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x)<>'number'
      or abs((x #>> '{}')::numeric)>1e10) then
    raise exception using errcode='22023', message='Invalid embedding vector';
  end if;
  v := p_value::text::extensions.vector(1536);
  if extensions.vector_norm(v)=0 then raise exception using errcode='22023', message='Zero embedding vector'; end if;
  return v;
exception when numeric_value_out_of_range then
  raise exception using errcode='22023', message='Invalid embedding vector';
end;
$$;

create function public.semantic_source_chunks(p_query_embedding jsonb,p_space_id text,p_profile_fingerprint text,
  p_source_ids text[] default null,p_limit integer default 20)
returns table(source_id text,version_id text,chunk_id text,title text,text text,section text,page integer,
  ordinal integer,score double precision,coverage_status text,workspace_revision bigint,distance double precision)
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_query extensions.vector;
begin
  perform conuo_private.validate_search(v_owner,p_space_id,p_source_ids,p_limit);
  if p_profile_fingerprint is null or p_profile_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023', message='Invalid embedding profile';
  end if;
  if exists(select 1 from public.embedding_profiles p where p.profile='embedding-v1'
    and p.fingerprint is not null and p.fingerprint<>p_profile_fingerprint) then
    raise exception using errcode='22023', message='Embedding profile mismatch';
  end if;
  v_query := conuo_private.parse_embedding(p_query_embedding);
  -- Iterative HNSW scan improves filtered recall on pgvector >= 0.8; exact small-set plans are also valid.
  perform set_config('hnsw.iterative_scan','strict_order',true);
  return query
    select c.source_id,c.version_id,c.chunk_id,s.title,c.text,c.section,c.page,c.ordinal,
      1-(e.embedding operator(extensions.<=>) v_query),v.status,w.revision,
      e.embedding operator(extensions.<=>) v_query
    from public.chunk_embeddings e
    join public.embedding_jobs j on j.job_id=e.job_id and j.generation=e.generation and j.state='succeeded'
    join public.embedding_profiles p on p.profile=j.profile and p.fingerprint=p_profile_fingerprint
    join public.source_chunks c on c.owner_id=e.owner_id and c.source_id=e.source_id and c.version_id=e.version_id and c.chunk_id=e.chunk_id and c.content_hash=e.content_hash
    join public.sources s on s.owner_id=c.owner_id and s.source_id=c.source_id and s.current_version_id=c.version_id
    join public.source_versions v on v.owner_id=c.owner_id and v.source_id=c.source_id and v.version_id=c.version_id and v.content_digest=j.content_digest
    join public.workspaces w on w.owner_id=c.owner_id
    where e.published and c.owner_id=v_owner and s.retained and v.retained and s.deleted_at is null
      and s.ai_allowed and w.data->>'aiEnabled'='true' and w.data->>'semanticSearch'='true'
      and v.status in ('ready','partial') and conuo_private.in_scope(w.data->'spaces',s.space_ids,p_space_id)
      and (p_source_ids is null or c.source_id=any(p_source_ids))
    order by e.embedding operator(extensions.<=>) v_query,c.source_id,c.position limit p_limit;
end;
$$;

-- Lock ordering is owner advisory lock, then job row everywhere (including workspace saves).
create function conuo_private.lock_embedding_job(p_job_id uuid,p_lease_token uuid,p_finished boolean default false)
returns public.embedding_jobs language plpgsql set search_path = '' as $$
declare j public.embedding_jobs; v_owner uuid;
begin
  select owner_id into v_owner from public.embedding_jobs where job_id=p_job_id;
  if v_owner is null then raise exception using errcode='40001', message='Embedding lease unavailable'; end if;
  perform conuo_private.owner_lock(v_owner);
  select * into j from public.embedding_jobs where job_id=p_job_id for update;
  if p_lease_token is null or j.lease_token is distinct from p_lease_token
    or not (j.state='running' or (p_finished and j.state='succeeded'))
    or (j.state='running' and (j.lease_until is null or j.lease_until<=clock_timestamp()))
    or not conuo_private.embedding_eligible(j.owner_id,j.source_id,j.version_id)
    or not exists(select 1 from public.source_versions v where v.owner_id=j.owner_id
      and v.source_id=j.source_id and v.version_id=j.version_id and v.content_digest=j.content_digest) then
    raise exception using errcode='40001', message='Embedding lease unavailable';
  end if;
  return j;
end;
$$;

create function public.claim_embedding_jobs(p_worker_id text,p_profile_fingerprint text,
  p_limit integer default 1,p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.embedding_jobs; candidate record; bound_fingerprint text; jobs jsonb := '[]';
begin
  if not conuo_private.valid_id(p_worker_id) or p_profile_fingerprint is null
    or p_profile_fingerprint !~ '^[a-f0-9]{64}$' or p_limit is null or p_limit not between 1 and 10
    or p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception using errcode='22023', message='Invalid embedding claim';
  end if;
  select fingerprint into bound_fingerprint from public.embedding_profiles where profile='embedding-v1' for update;
  if bound_fingerprint is not null and bound_fingerprint<>p_profile_fingerprint then
    raise exception using errcode='22023', message='Embedding profile mismatch';
  end if;
  if bound_fingerprint is null then
    update public.embedding_profiles set fingerprint=p_profile_fingerprint where profile='embedding-v1';
  end if;
  for candidate in select job_id,owner_id from public.embedding_jobs
    where (state='queued' and next_attempt_at<=clock_timestamp())
      or (state='running' and lease_until<=clock_timestamp())
    order by next_attempt_at,created_at,job_id limit p_limit*100 loop
    if not pg_try_advisory_xact_lock(hashtextextended('conuo:source:' || candidate.owner_id::text,0)) then continue; end if;
    select * into j from public.embedding_jobs where job_id=candidate.job_id
      and ((state='queued' and next_attempt_at<=clock_timestamp()) or (state='running' and lease_until<=clock_timestamp()))
      for update skip locked;
    if not found then continue; end if;
    if not conuo_private.embedding_eligible(j.owner_id,j.source_id,j.version_id) then
      update public.embedding_jobs set state='cancelled',cancel_reason='ineligible',error_code='SOURCE_INELIGIBLE',
        lease_token=null,lease_until=null,updated_at=now() where job_id=j.job_id;
      update public.chunk_embeddings set published=false where job_id=j.job_id;
      continue;
    end if;
    if j.attempt>=5 then
      update public.embedding_jobs set state='failed',error_code='ATTEMPTS_EXHAUSTED',
        lease_token=null,lease_until=null,updated_at=now() where job_id=j.job_id;
      continue;
    end if;
    update public.embedding_jobs set state='running',attempt=attempt+1,worker_id=p_worker_id,
      lease_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      error_code=null,updated_at=now() where job_id=j.job_id returning * into j;
    jobs := jobs || jsonb_build_array(jsonb_build_object('jobId',j.job_id,'ownerId',j.owner_id,
      'sourceId',j.source_id,'versionId',j.version_id,'contentDigest',j.content_digest,
      'profile',j.profile,'dimensions',1536,'leaseToken',j.lease_token,'leaseUntil',j.lease_until,
      'cursor',j.cursor,'totalChunks',j.total_chunks,'attempt',j.attempt));
    exit when jsonb_array_length(jobs)>=p_limit;
  end loop;
  return jsonb_build_object('jobs',jobs);
end;
$$;

create function public.read_embedding_batch(p_job_id uuid,p_lease_token uuid,p_limit integer default 32)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.embedding_jobs; chunks jsonb;
begin
  if p_limit is null or p_limit not between 1 and 32 then
    raise exception using errcode='22023', message='Invalid embedding batch size';
  end if;
  j := conuo_private.lock_embedding_job(p_job_id,p_lease_token);
  select coalesce(jsonb_agg(jsonb_build_object('chunkId',c.chunk_id,'text',c.text,
    'contentHash',c.content_hash,'ordinal',c.ordinal) order by c.position),'[]'::jsonb) into chunks
    from (select * from public.source_chunks where owner_id=j.owner_id and source_id=j.source_id
      and version_id=j.version_id and position>=j.cursor order by position limit p_limit) c;
  return jsonb_build_object('jobId',j.job_id,'ownerId',j.owner_id,'cursor',j.cursor,'totalChunks',j.total_chunks,'chunks',chunks);
end;
$$;

create function public.commit_embedding_batch(p_job_id uuid,p_lease_token uuid,p_start integer,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.embedding_jobs; row jsonb; c public.source_chunks; v extensions.vector;
  n integer; i integer := 0;
begin
  if p_start is null or p_start<0 or jsonb_typeof(p_rows) is distinct from 'array'
    or jsonb_array_length(p_rows) not between 1 and 32 then
    raise exception using errcode='22023', message='Invalid embedding batch';
  end if;
  j := conuo_private.lock_embedding_job(p_job_id,p_lease_token);
  n := jsonb_array_length(p_rows);
  if p_start>j.cursor or p_start::bigint+n>j.total_chunks
    or (p_start<j.cursor and p_start+n>j.cursor) then
    raise exception using errcode='40001', message='Embedding cursor conflict';
  end if;
  for row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(row)<>'object' or (select count(*) from jsonb_object_keys(row))<>3
      or not conuo_private.valid_id(row->>'chunkId') or coalesce(row->>'contentHash','') !~ '^[a-f0-9]{64}$' then
      raise exception using errcode='22023', message='Invalid embedding row';
    end if;
    select * into c from public.source_chunks where owner_id=j.owner_id and source_id=j.source_id
      and version_id=j.version_id and position=p_start+i;
    if not found or c.chunk_id is distinct from row->>'chunkId' or c.content_hash is distinct from row->>'contentHash' then
      raise exception using errcode='22023', message='Embedding chunk mismatch';
    end if;
    v := conuo_private.parse_embedding(row->'embedding');
    if p_start<j.cursor then
      if not exists(select 1 from public.chunk_embeddings e where e.job_id=j.job_id and e.generation=j.generation
        and e.chunk_id=c.chunk_id and e.content_hash=c.content_hash and e.embedding::text=v::text) then
        raise exception using errcode='40001', message='Embedding retry mismatch';
      end if;
    else
      insert into public.chunk_embeddings(job_id,generation,owner_id,source_id,version_id,chunk_id,content_hash,embedding)
        values(j.job_id,j.generation,j.owner_id,j.source_id,j.version_id,c.chunk_id,c.content_hash,v);
    end if;
    i := i+1;
  end loop;
  if p_start=j.cursor then
    update public.embedding_jobs set cursor=cursor+n,updated_at=now() where job_id=j.job_id returning * into j;
  end if;
  return jsonb_build_object('cursor',j.cursor,'totalChunks',j.total_chunks,'state',j.state);
end;
$$;

create function public.finish_embedding_job(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.embedding_jobs;
begin
  j := conuo_private.lock_embedding_job(p_job_id,p_lease_token,true);
  if j.cursor<>j.total_chunks or (select count(*) from public.chunk_embeddings e
    join public.source_chunks c on c.owner_id=e.owner_id and c.source_id=e.source_id and c.version_id=e.version_id
      and c.chunk_id=e.chunk_id and c.content_hash=e.content_hash
    where e.job_id=j.job_id and e.generation=j.generation)<>j.total_chunks then
    raise exception using errcode='40001', message='Embedding job incomplete';
  end if;
  update public.chunk_embeddings set published=true where job_id=j.job_id and generation=j.generation;
  update public.embedding_jobs set state='succeeded',error_code=null,updated_at=now() where job_id=j.job_id;
  return jsonb_build_object('state','succeeded');
end;
$$;

create function public.heartbeat_embedding_job(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.embedding_jobs;
begin
  if p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception using errcode='22023', message='Invalid embedding lease duration';
  end if;
  j := conuo_private.lock_embedding_job(p_job_id,p_lease_token);
  update public.embedding_jobs set lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=now()
    where job_id=j.job_id returning * into j;
  return jsonb_build_object('leaseUntil',j.lease_until);
end;
$$;

create function public.fail_embedding_job(p_job_id uuid,p_lease_token uuid,p_error_code text,p_retryable boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.embedding_jobs;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' or p_retryable is null then
    raise exception using errcode='22023', message='Invalid embedding failure';
  end if;
  j := conuo_private.lock_embedding_job(p_job_id,p_lease_token);
  update public.embedding_jobs set state=case when p_retryable and attempt<5 then 'queued' else 'failed' end,
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(900,15*(2^(attempt-1))::integer)),
    error_code=p_error_code,lease_token=null,lease_until=null,updated_at=now()
    where job_id=j.job_id returning * into j;
  return jsonb_build_object('state',j.state,'nextAttemptAt',j.next_attempt_at);
end;
$$;

create function public.control_embedding_job(p_job_id uuid,p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); j public.embedding_jobs;
begin
  if v_owner is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_action is null or p_action not in ('cancel','retry') then
    raise exception using errcode='22023', message='Invalid embedding action';
  end if;
  perform conuo_private.owner_lock(v_owner);
  select * into j from public.embedding_jobs where job_id=p_job_id and owner_id=v_owner for update;
  if not found then raise exception using errcode='40001', message='Embedding job unavailable'; end if;
  if p_action='cancel' then
    update public.embedding_jobs set state='cancelled',cancel_reason='user',lease_token=null,lease_until=null,
      error_code='USER_CANCELLED',updated_at=now() where job_id=j.job_id;
    update public.chunk_embeddings set published=false where job_id=j.job_id;
    return jsonb_build_object('state','cancelled');
  end if;
  if not conuo_private.embedding_eligible(j.owner_id,j.source_id,j.version_id) then
    raise exception using errcode='40001', message='Embedding source unavailable';
  end if;
  if j.state='queued' then return jsonb_build_object('state','queued'); end if;
  if j.state not in ('failed','cancelled') then
    raise exception using errcode='40001', message='Embedding job cannot retry';
  end if;
  delete from public.chunk_embeddings where job_id=j.job_id;
  update public.embedding_jobs set state='queued',generation=generation+1,cursor=0,attempt=0,
    cancel_reason=null,error_code=null,lease_token=null,lease_until=null,next_attempt_at=now(),updated_at=now()
    where job_id=j.job_id;
  return jsonb_build_object('state','queued');
end;
$$;

create function public.embedding_job_status(p_source_ids text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); jobs jsonb;
begin
  perform conuo_private.validate_search(v_owner,'*',p_source_ids,100);
  select coalesce(jsonb_agg(jsonb_build_object('jobId',j.job_id,'sourceId',j.source_id,'versionId',j.version_id,
    'state',j.state,'cursor',j.cursor,'totalChunks',j.total_chunks,'attempt',j.attempt,
    'errorCode',j.error_code,'nextAttemptAt',j.next_attempt_at,'updatedAt',j.updated_at,
    'profile',j.profile,'profileFingerprint',p.fingerprint,'cancelReason',j.cancel_reason) order by j.created_at desc),'[]'::jsonb) into jobs
    from public.embedding_jobs j join public.sources s on s.owner_id=j.owner_id and s.source_id=j.source_id
    join public.embedding_profiles p on p.profile=j.profile
    -- One current-profile task per retained source bounds status by the 5,000-source snapshot cap.
    -- Historical jobs remain stored for audit, but are not part of the actionable status view.
    where j.owner_id=v_owner and s.retained and j.version_id=s.current_version_id
      and j.profile='embedding-v1' and (p_source_ids is null or j.source_id=any(p_source_ids));
  return jsonb_build_object('jobs',jobs);
end;
$$;

-- A character budget is an admission bound, not a price/currency ceiling. Failures consume reservations.
create function public.reserve_embedding_usage(p_owner_id uuid,p_request_id text,p_characters integer,
  p_daily_char_limit integer default 200000)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_day date := (clock_timestamp() at time zone 'UTC')::date; used bigint;
begin
  if p_owner_id is null or not conuo_private.valid_id(p_request_id) or p_characters is null
    or p_characters not between 1 and 200000 or p_daily_char_limit is null
    or p_daily_char_limit not between 1 and 10000000 then
    raise exception using errcode='22023', message='Invalid embedding usage reservation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('conuo:embedding-usage:' || p_owner_id::text,0));
  if exists(select 1 from public.embedding_usage where owner_id=p_owner_id and request_id=p_request_id) then
    return jsonb_build_object('allowed',false);
  end if;
  select coalesce(sum(characters),0) into used from public.embedding_usage where owner_id=p_owner_id and usage_date=v_day;
  if used+p_characters>p_daily_char_limit then return jsonb_build_object('allowed',false); end if;
  insert into public.embedding_usage(owner_id,request_id,usage_date,characters) values(p_owner_id,p_request_id,v_day,p_characters);
  return jsonb_build_object('allowed',true);
end;
$$;

-- Explicit grants on every exposed function; private helpers have no caller execution privileges.
revoke all on all functions in schema conuo_private from public,anon,authenticated,service_role;
revoke all on function public.save_workspace(jsonb,bigint) from public,anon,service_role;
grant execute on function public.save_workspace(jsonb,bigint) to authenticated;
revoke all on function public.search_source_chunks(text,text,text[],boolean,integer),
  public.semantic_source_chunks(jsonb,text,text,text[],integer),public.control_embedding_job(uuid,text),
  public.embedding_job_status(text[]) from public,anon,service_role;
grant execute on function public.search_source_chunks(text,text,text[],boolean,integer),
  public.semantic_source_chunks(jsonb,text,text,text[],integer),public.control_embedding_job(uuid,text),
  public.embedding_job_status(text[]) to authenticated;
revoke all on function public.claim_embedding_jobs(text,text,integer,integer),
  public.read_embedding_batch(uuid,uuid,integer),public.commit_embedding_batch(uuid,uuid,integer,jsonb),
  public.finish_embedding_job(uuid,uuid),public.heartbeat_embedding_job(uuid,uuid,integer),
  public.fail_embedding_job(uuid,uuid,text,boolean),public.reserve_embedding_usage(uuid,text,integer,integer)
  from public,anon,authenticated;
grant execute on function public.claim_embedding_jobs(text,text,integer,integer),
  public.read_embedding_batch(uuid,uuid,integer),public.commit_embedding_batch(uuid,uuid,integer,jsonb),
  public.finish_embedding_job(uuid,uuid),public.heartbeat_embedding_job(uuid,uuid,integer),
  public.fail_embedding_job(uuid,uuid,text,boolean),public.reserve_embedding_usage(uuid,text,integer,integer)
  to service_role;

-- Existing workspaces are projected in the same migration transaction, with the same validation.
-- Invalid old identities fail migration explicitly instead of being silently rewritten or omitted.
do $$
declare w record;
begin
  for w in select owner_id,data from public.workspaces loop
    perform conuo_private.owner_lock(w.owner_id);
    perform conuo_private.project_workspace(w.owner_id,w.data);
  end loop;
end;
$$;

comment on table public.embedding_jobs is 'Durable indexing outbox and lease queue; delivery is not publication.';
comment on column public.source_versions.manifest is 'Immutable body/locator/original metadata; mutable title and library identity live on sources.';
commit;
