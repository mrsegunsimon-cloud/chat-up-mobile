-- DEVELOPER STEP. Run in the Supabase SQL Editor AFTER deploying the cleanup-statuses function.
-- Before running, replace the two placeholders:
--   YOUR-PROJECT-REF  -> the part before .supabase.co in your project URL
--   YOUR-SERVICE-ROLE-KEY -> Project Settings > API > service_role key.
--     This key is secret. Paste it only here, in your own SQL Editor. Never put it in the app or share it in chat.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('YOUR-SERVICE-ROLE-KEY', 'service_role_key');

-- Runs at the start of every hour.
select cron.schedule('cleanup-statuses', '0 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/cleanup-statuses',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
$$);

-- Check later: select * from cron.job_run_details order by start_time desc limit 5;
