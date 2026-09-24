-- Deployment operations for conuo-staging only. Submit for human review; do not execute here.
-- Requires the processor secret to exist in Supabase Vault before enabling the schedule.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $$
begin
  if (select count(*) from vault.secrets where name = 'conuo_staging_processor_secret') <> 1 then
    raise exception 'The staging processor secret must be configured in Vault first';
  end if;
end;
$$;
select cron.schedule(
  'conuo-staging-summary', '* * * * *',
  $job$
    select net.http_post(
      url := 'https://conuo-staging.vercel.app/api/internal/summary-processor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'conuo_staging_processor_secret')
      ),
      body := '{"workerId":"supabase-staging-summary","maxJobs":1,"maxSeconds":50}'::jsonb,
      timeout_milliseconds := 65000
    );
  $job$
);
commit;
select jobid, jobname, schedule, active from cron.job where jobname = 'conuo-staging-summary';
