-- Create charger_sync_url and charger_sync_secret in Supabase Vault first.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'charger_sync_url'
      and decrypted_secret ~ '^https://[^/]+/api/cron/chargers$'
  ) then
    raise exception 'Set charger_sync_url in Vault to the HTTPS production sync URL.';
  end if;
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'charger_sync_secret' and length(decrypted_secret) > 0
  ) then
    raise exception 'Set charger_sync_secret in Vault to the production CRON_SECRET.';
  end if;
end;
$$;

select cron.schedule(
  'sync-jeju-charger-status',
  '*/5 * * * *',
  $job$
    select net.http_get(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'charger_sync_url'),
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'charger_sync_secret')
      ),
      timeout_milliseconds := 55000
    );
  $job$
);
