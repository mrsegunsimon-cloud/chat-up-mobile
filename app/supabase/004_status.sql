-- Run once in the Supabase SQL Editor after 003_recording_consent.sql.
-- Statuses: text, photo or video (up to 30 minutes). Visible for 24 hours to people you share a chat with.
create table statuses (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles on delete cascade default auth.uid(),
  kind text not null check (kind in ('text', 'photo', 'video')),
  body text,
  media_path text,
  bg int not null default 0,
  duration_s int check (duration_s is null or duration_s <= 1800),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  check ((kind = 'text' and body is not null) or (kind <> 'text' and media_path is not null))
);
create index on statuses (user_id, created_at desc);
alter table statuses enable row level security;

create function can_see_user(uid uuid) returns boolean language sql security definer stable set search_path = public as $$
  select uid = auth.uid() or exists (
    select 1 from conversation_members a join conversation_members b on a.conversation_id = b.conversation_id
    where a.user_id = auth.uid() and b.user_id = uid)
$$;

create policy "see statuses of chat partners" on statuses for select to authenticated
  using (expires_at > now() and can_see_user(user_id));
create policy "post own status" on statuses for insert to authenticated with check (user_id = auth.uid());
create policy "delete own status" on statuses for delete to authenticated using (user_id = auth.uid());

-- Private media bucket, one folder per person. Per-file limit 1 GB here; your Supabase plan may set a lower global limit.
insert into storage.buckets (id, name, public, file_size_limit) values ('status-media', 'status-media', false, 1073741824);
create policy "upload own status media" on storage.objects for insert to authenticated
  with check (bucket_id = 'status-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "delete own status media" on storage.objects for delete to authenticated
  using (bucket_id = 'status-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "see partners status media" on storage.objects for select to authenticated
  using (bucket_id = 'status-media' and can_see_user(((storage.foldername(name))[1])::uuid));

-- TODO (developer): expired rows stop showing after 24 h, but their files stay in storage.
-- Add a scheduled job (pg_cron + an Edge Function) that deletes expired rows and their files.
