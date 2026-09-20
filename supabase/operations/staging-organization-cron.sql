-- Deployment operations for conuo-staging (yyleaedclbhsiowsaunt) only.
-- Not a schema migration. Requires the named secret to exist in Supabase Vault.
-- Never paste secret values into this file or a SQL Editor query.
-- Pause with: select cron.alter_job(job_id := <verified job ID>, active := false);
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
  'conuo-staging-organization',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://conuo-staging.vercel.app/api/internal/organization-processor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'conuo_staging_processor_secret'
        )
      ),
      body := '{"workerId":"supabase-staging-cron","limit":1,"leaseSeconds":120}'::jsonb,
      timeout_milliseconds := 65000
    );
  $job$
);

commit;

-- Confirm both the schedule and the actual HTTP outcome. A successful cron SQL
-- call only means the HTTP request was queued, not that a job was processed.
select jobid, jobname, schedule, active from cron.job
where jobname = 'conuo-staging-organization';
-- After the next scheduled tick:
-- select id, status_code, timed_out, error_msg, content, created
-- from net._http_response order by created desc limit 5;
