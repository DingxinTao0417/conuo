-- Manual, read-only report. Run with a service_role SQL session.
-- Replace the placeholder prices with the provider's current USD prices per
-- one million tokens before using the estimated_cost_usd column.
with price_parameters as (
  select
    0::numeric as prompt_price_usd_per_million,
    0::numeric as completion_price_usd_per_million
),
daily_model_usage as (
  select
    (t.created_at at time zone 'UTC')::date as usage_date,
    coalesce(t.model_profile, 'unknown') as model_profile,
    sum(
      case
        when t.metrics->>'promptTokens' ~ '^[0-9]+$'
          then least((t.metrics->>'promptTokens')::numeric, 9007199254740991)
        else 0
      end
    ) as prompt_tokens,
    sum(
      case
        when t.metrics->>'completionTokens' ~ '^[0-9]+$'
          then least((t.metrics->>'completionTokens')::numeric, 9007199254740991)
        else 0
      end
    ) as completion_tokens,
    count(*) as trace_count
  from conuo_private.ai_request_traces t
  group by 1, 2
)
select
  usage_date,
  model_profile,
  prompt_tokens,
  completion_tokens,
  prompt_tokens + completion_tokens as total_tokens,
  trace_count,
  (
    prompt_tokens * price_parameters.prompt_price_usd_per_million
      + completion_tokens * price_parameters.completion_price_usd_per_million
  ) / 1000000 as estimated_cost_usd
from daily_model_usage
cross join price_parameters
order by usage_date desc, model_profile;
