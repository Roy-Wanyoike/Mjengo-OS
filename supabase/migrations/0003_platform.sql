-- ============================================================================
-- Mjengo-OS — Supabase target-state platform layer (issue #95, ADR 0002)
-- File: supabase/migrations/0003_platform.sql
-- (requires 0001_schema.sql + 0002_rls.sql applied)
--
-- Storage buckets + policies, Realtime publication, pg_cron jobs-drain.
-- Design doc: docs/SUPABASE-DATABASE-DESIGN.md §7–§8.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §7. Storage buckets
--
-- Path convention (both buckets): '{project_id}/<object-name>' — the FIRST
-- folder segment is always the owning project id. Storage policies are
-- path-tenancy based (storage.objects carries no DB join).
--
--   site-photos  PUBLIC  — preserves today's share-link posture (local-disk
--                          driver serves /public/photos openly). Review item
--                          S-1 in the design doc covers signed-URL hardening;
--                          changing it breaks share links, so it is a product
--                          decision, not a silent migration.
--   documents    PRIVATE — parcel docs, invoices, quotes, permits, voice
--                          transcripts. Served via signed URLs minted by the
--                          service; downloads also gated by the select policy.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-photos', 'site-photos', true, 10485760, null)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520, null)
on conflict (id) do nothing;

-- Helper: the owning project of a storage object (first path segment).
create or replace function public.storage_project_of(obj_name text) returns text
language sql stable as
$$ select nullif((storage.foldername(obj_name))[1], '') $$;

-- site-photos: public bucket → public read via the public URL (no select
-- policy needed); writes are tenancy-checked.
create policy storage_site_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'site-photos'
              and (public.is_staff()
                   or (public.app_role() = 'client'
                       and public.storage_project_of(name) = public.app_project_id())));
create policy storage_site_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'site-photos' and public.is_staff())
  with check (bucket_id = 'site-photos' and public.is_staff());
create policy storage_site_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'site-photos' and public.is_staff());

-- documents: private — read AND write tenancy-checked.
create policy storage_documents_select on storage.objects for select to authenticated
  using (bucket_id = 'documents'
         and (public.is_staff()
              or (public.app_role() = 'client'
                  and public.storage_project_of(name) = public.app_project_id())));
create policy storage_documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents'
              and (public.is_staff()
                   or (public.app_role() = 'client'
                       and public.storage_project_of(name) = public.app_project_id())));
create policy storage_documents_update on storage.objects for update to authenticated
  using (bucket_id = 'documents' and public.is_staff())
  with check (bucket_id = 'documents' and public.is_staff());
create policy storage_documents_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.is_staff());

-- ---------------------------------------------------------------------------
-- §8. Realtime (Postgres CDC)
--
-- notifications  → live badge/toast fan-out for signed-in users (the in-app
--                  notification center gets push instead of polling).
-- domain_events  → ops/debug visibility into the event chains (spec §59).
--
-- Realtime filters through RLS per subscriber; replica identity full is
-- required so UPDATE/DELETE payloads can carry row context.
-- ---------------------------------------------------------------------------

alter table public.notifications replica identity full;
alter table public.domain_events replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.notifications';
    execute 'alter publication supabase_realtime add table public.domain_events';
  else
    raise notice 'supabase_realtime publication not present — enable Realtime add-on first, then re-run this block';
  end if;
exception
  when duplicate_object then null; -- table already in the publication
end $$;

-- ---------------------------------------------------------------------------
-- §9. pg_cron + pg_net — jobs queue drain (replaces the systemd timer)
--
-- The queue stays DB-backed (public.job_records); the DRAIN still runs in the
-- app (POST /api/jobs/run keeps its bearer-token guard + JOBS_RUN_TOKEN env,
-- mirroring the audited fail-closed posture). pg_cron just ticks it.
--
-- SECRET HANDLING (no secrets in SQL, ever):
--   1. Ops stores the token in Supabase Vault:  name = 'mjengo_jobs_run_token'
--   2. Ops stores the app host in Vault:        name = 'mjengo_app_url'
--   3. The schedule below reads BOTH from vault.decrypted_secrets at run time.
-- The DO block no-ops (with a notice) when either secret is missing — the
-- design never embeds a host or token in a migration file.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  app_url  text;
  schedule text := '*/5 * * * *'; -- every 5 minutes (systemd timer cadence)
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'mjengo_app_url')
     or not exists (select 1 from vault.decrypted_secrets where name = 'mjengo_jobs_run_token') then
    raise notice 'mjengo cron drain not scheduled: store vault secrets mjengo_app_url + mjengo_jobs_run_token, then run the cron.schedule statement from docs/SUPABASE-DATABASE-DESIGN.md §9';
    return;
  end if;

  select decrypted_secret into app_url from vault.decrypted_secrets where name = 'mjengo_app_url';

  perform cron.schedule('mjengo-jobs-drain', schedule, format($f$
    select net.http_post(
      url := '%s/api/jobs/run',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret
                                       from vault.decrypted_secrets
                                       where name = 'mjengo_jobs_run_token'),
        'Content-Type', 'application/json'),
      body := '{}'::jsonb
    )$f$, app_url));
end $$;

-- Template for ops (run AFTER storing the vault secrets, if the DO block
-- above no-opped):
--   select cron.schedule('mjengo-jobs-drain', '*/5 * * * *', $$
--     select net.http_post(
--       url    := (select decrypted_secret from vault.decrypted_secrets where name = 'mjengo_app_url') || '/api/jobs/run',
--       headers := jsonb_build_object(
--         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'mjengo_jobs_run_token'),
--         'Content-Type', 'application/json'),
--       body   := '{}'::jsonb)
--   $$);

-- Observability note (design doc §Operability): job_records itself is the
-- drain's own audit surface — monitor status='failed' rows and the
-- Supabase pg_cron catalog (cron.job_run_details) for tick health.

-- ============================================================================
-- End of 0003_platform.sql
-- ============================================================================
