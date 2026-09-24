begin;

-- Copied from 20260925000500_learning_foundation.sql, changed: compute weak
-- concepts from the last five review logs and return their current citations.
create or replace function public.learning_overview(p_space_id text) returns jsonb language sql security definer set search_path = '' as $$
with scoped_items as (
  select i.*
  from public.learning_items i
  where i.owner_id = auth.uid()
    and (p_space_id = 'all' or i.space_id = p_space_id)
    and i.deleted_at is null
    and i.status = 'active'
),
overview_counts as (
  select
    count(*) filter (where s.due_at <= now())::integer as due_count,
    count(*) filter (where s.reps = 0)::integer as new_count,
    (
      select count(*)::integer
      from public.review_logs l
      join scoped_items i using (owner_id, item_id)
      where l.reviewed_at >= now() - interval '7 days'
    ) as reviews_last_7d
  from scoped_items i
  join public.review_states s using (owner_id, item_id)
),
recent_reviews as (
  select
    i.concept_key,
    l.item_id,
    l.rating,
    l.grade,
    l.reviewed_at,
    l.log_id,
    row_number() over (
      partition by i.concept_key
      order by l.reviewed_at desc, l.log_id desc
    ) as review_position
  from public.review_logs l
  join scoped_items i using (owner_id, item_id)
  where i.concept_key is not null
),
weak_groups as (
  select
    concept_key,
    count(*) filter (where rating = 1)::integer as forgotten_count,
    coalesce(bool_or(review_position = 1 and grade->>'verdict' = 'incorrect'), false) as latest_incorrect,
    max(reviewed_at) as last_review_at
  from recent_reviews
  where review_position <= 5
  group by concept_key
  having count(*) filter (where rating = 1) >= 2
    or bool_or(review_position = 1 and grade->>'verdict' = 'incorrect')
),
weak_ranked as (
  select
    w.concept_key,
    w.forgotten_count,
    w.latest_incorrect,
    w.last_review_at,
    coalesce((
      select min(i.space_id)
      from scoped_items i
      where i.concept_key = w.concept_key
    ), 'inbox') as space_id,
    (
      select coalesce(jsonb_agg(item_id order by item_id), '[]'::jsonb)
      from (
        select distinct i.item_id
        from scoped_items i
        where i.concept_key = w.concept_key
        order by i.item_id
        limit 5
      ) items
    ) as item_ids,
    (
      select coalesce(jsonb_agg(citation order by item_id, chunk_sort), '[]'::jsonb)
      from (
        select distinct i.item_id, c.value as citation, c.value->>'chunkId' as chunk_sort
        from scoped_items i
        cross join lateral jsonb_array_elements(coalesce(i.citations, '[]'::jsonb)) c(value)
        where i.concept_key = w.concept_key
        order by i.item_id, chunk_sort
        limit 6
      ) citations
    ) as citations
  from weak_groups w
)
select jsonb_build_object(
  'dueCount', o.due_count,
  'newCount', o.new_count,
  'reviewsLast7d', o.reviews_last_7d,
  'weakConcepts', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'conceptKey', w.concept_key,
        'forgottenCount', w.forgotten_count,
        'latestIncorrect', w.latest_incorrect,
        'spaceId', w.space_id,
        'itemIds', w.item_ids,
        'citations', w.citations
      )
      order by w.last_review_at desc, w.concept_key
    )
    from (select * from weak_ranked order by last_review_at desc, concept_key limit 5) w
  ), '[]'::jsonb)
)
from overview_counts o;
$$;

commit;
