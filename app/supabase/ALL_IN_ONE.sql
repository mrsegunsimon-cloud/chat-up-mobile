-- Chat Up: everything in one file, for a NEW empty database. Run once.

-- ===== schema.sql =====
-- Chat Up schema. Run once in Supabase: SQL Editor > New query > Run.
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  phone text unique,
  name text
);
create function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, phone) values (new.id, new.phone);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

create table conversations (id uuid primary key default gen_random_uuid(), created_at timestamptz default now());
create table conversation_members (
  conversation_id uuid references conversations on delete cascade,
  user_id uuid references profiles on delete cascade,
  primary key (conversation_id, user_id)
);
create table messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references conversations on delete cascade,
  sender_id uuid not null references profiles default auth.uid(),
  body text,
  image_path text,
  created_at timestamptz default now(),
  check (body is not null or image_path is not null)
);
create index on messages (conversation_id, created_at);

create function is_member(cid uuid) returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from conversation_members where conversation_id = cid and user_id = auth.uid())
$$;

alter table profiles enable row level security;
alter table conversations enable row level security;
alter table conversation_members enable row level security;
alter table messages enable row level security;

create policy "see self and chat partners" on profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from conversation_members a join conversation_members b on a.conversation_id = b.conversation_id
    where a.user_id = auth.uid() and b.user_id = profiles.id));
create policy "edit own profile" on profiles for update to authenticated using (id = auth.uid());
create policy "members see chat" on conversations for select to authenticated using (is_member(id));
create policy "members see members" on conversation_members for select to authenticated using (is_member(conversation_id));
create policy "members read messages" on messages for select to authenticated using (is_member(conversation_id));
create policy "members send messages" on messages for insert to authenticated
  with check (sender_id = auth.uid() and is_member(conversation_id));

-- Start (or reopen) a one-to-one chat by phone number.
create function start_chat(other_phone text) returns uuid language plpgsql security definer set search_path = public as $$
declare other uuid; cid uuid;
begin
  select id into other from profiles where phone = regexp_replace(other_phone, '\D', '', 'g');
  if other is null then raise exception 'No Chat Up user with that number'; end if;
  if other = auth.uid() then raise exception 'That is your own number'; end if;
  select a.conversation_id into cid from conversation_members a join conversation_members b
    on a.conversation_id = b.conversation_id where a.user_id = auth.uid() and b.user_id = other limit 1;
  if cid is null then
    insert into conversations default values returning id into cid;
    insert into conversation_members values (cid, auth.uid()), (cid, other);
  end if;
  return cid;
end $$;

create function my_chats() returns table (conversation_id uuid, other_name text, other_phone text, last_body text, last_at timestamptz)
language sql security definer stable set search_path = public as $$
  select m.conversation_id, p.name, p.phone,
    (select coalesce(x.body, 'Photo') from messages x where x.conversation_id = m.conversation_id order by x.created_at desc limit 1),
    (select max(x.created_at) from messages x where x.conversation_id = m.conversation_id)
  from conversation_members m
  join conversation_members o on o.conversation_id = m.conversation_id and o.user_id <> m.user_id
  join profiles p on p.id = o.user_id
  where m.user_id = auth.uid()
  order by 5 desc nulls last
$$;

-- Photos: private bucket, folder per conversation.
insert into storage.buckets (id, name, public) values ('chat-images', 'chat-images', false);
create policy "members read photos" on storage.objects for select to authenticated
  using (bucket_id = 'chat-images' and is_member(((storage.foldername(name))[1])::uuid));
create policy "members upload photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-images' and is_member(((storage.foldername(name))[1])::uuid));

alter publication supabase_realtime add table messages;


-- ===== 002_voice_push.sql =====
-- Run once in Supabase SQL Editor AFTER schema.sql.
-- Voice notes: stored in the same private 'chat-images' bucket, in the conversation's folder.
alter table messages add column audio_path text;
alter table messages drop constraint messages_check;
alter table messages add constraint messages_content_check
  check (body is not null or image_path is not null or audio_path is not null);

create or replace function my_chats() returns table (conversation_id uuid, other_name text, other_phone text, last_body text, last_at timestamptz)
language sql security definer stable set search_path = public as $$
  select m.conversation_id, p.name, p.phone,
    (select coalesce(x.body, case when x.audio_path is not null then 'Voice note' else 'Photo' end)
       from messages x where x.conversation_id = m.conversation_id order by x.created_at desc limit 1),
    (select max(x.created_at) from messages x where x.conversation_id = m.conversation_id)
  from conversation_members m
  join conversation_members o on o.conversation_id = m.conversation_id and o.user_id <> m.user_id
  join profiles p on p.id = o.user_id
  where m.user_id = auth.uid()
  order by 5 desc nulls last
$$;

-- Push notifications: each phone saves its Expo push token here.
create table push_tokens (
  token text primary key,
  user_id uuid not null references profiles on delete cascade default auth.uid(),
  created_at timestamptz default now()
);
alter table push_tokens enable row level security;
create policy "own tokens" on push_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===== 003_recording_consent.sql =====
-- Run once in the Supabase SQL Editor after 002_voice_push.sql.
-- Each person decides whether others may screen record their video on calls. Off by default.
alter table profiles add column allow_recording boolean not null default false;
-- Chat partners can already read each other's profile row, so a call screen can check this flag.

-- ===== 004_status.sql =====
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

-- ===== 005_schedule_cleanup.sql =====
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

-- ===== 006_read_state.sql =====
-- Run once in the Supabase SQL Editor after 005_schedule_cleanup.sql (or after 004 if you skipped 005).
-- Adds read tracking: unread counts in the chat list and sent/read ticks on messages.
alter table conversation_members add column last_read_at timestamptz not null default now();

-- Marks a chat as read for the signed-in person. A function, so people can't edit other columns of the row.
create function mark_read(cid uuid) returns void language sql security definer set search_path = public as $$
  update conversation_members set last_read_at = now() where conversation_id = cid and user_id = auth.uid()
$$;

drop function my_chats();
create function my_chats() returns table (
  conversation_id uuid, other_name text, other_phone text, last_body text, last_at timestamptz,
  last_from_me boolean, unread int, other_last_read timestamptz)
language sql security definer stable set search_path = public as $$
  select m.conversation_id, p.name, p.phone, lm.label, lm.created_at, (lm.sender_id = auth.uid()),
    (select count(*)::int from messages x where x.conversation_id = m.conversation_id and x.sender_id <> auth.uid() and x.created_at > m.last_read_at),
    o.last_read_at
  from conversation_members m
  join conversation_members o on o.conversation_id = m.conversation_id and o.user_id <> m.user_id
  join profiles p on p.id = o.user_id
  left join lateral (
    select coalesce(x.body, case when x.audio_path is not null then 'Voice note' else 'Photo' end) as label, x.created_at, x.sender_id
    from messages x where x.conversation_id = m.conversation_id order by x.created_at desc limit 1) lm on true
  where m.user_id = auth.uid()
  order by lm.created_at desc nulls last
$$;

-- Lets the other person's phone see your read ticks turn on live.
alter publication supabase_realtime add table conversation_members;

-- ===== 007_groups.sql =====
-- Run once in the Supabase SQL Editor after 006_read_state.sql.
-- Adds group chats: a group has a name and 3 to 50 members. Members can read and send; only the creator can't yet add or remove people (not built).
alter table conversations add column is_group boolean not null default false;
alter table conversations add column name text;
alter table conversations add column created_by uuid references profiles on delete set null;

-- Create a group from a name and a list of phone numbers. Everyone must already have signed in to Chat Up.
create function create_group(group_name text, member_phones text[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid; ids uuid[]; missing text; clean text[]; n text := btrim(group_name);
begin
  if n is null or n = '' or length(n) > 40 then raise exception 'Give the group a name of 1 to 40 characters'; end if;
  select array_agg(distinct regexp_replace(p, '\D', '', 'g')) into clean from unnest(member_phones) p where regexp_replace(p, '\D', '', 'g') <> '';
  if clean is null then raise exception 'Add at least 2 people'; end if;
  select array_agg(id) into ids from profiles where phone = any(clean) and id <> auth.uid();
  select string_agg('+' || c, ', ') into missing from unnest(clean) c
    where not exists (select 1 from profiles where phone = c) ;
  if missing is not null then raise exception 'Not on Chat Up yet: %', missing; end if;
  if coalesce(array_length(ids, 1), 0) < 2 then raise exception 'Add at least 2 other people'; end if;
  if array_length(ids, 1) > 49 then raise exception 'A group can have up to 50 people including you'; end if;
  insert into conversations (is_group, name, created_by) values (true, n, auth.uid()) returning id into cid;
  insert into conversation_members (conversation_id, user_id) select cid, auth.uid() union select cid, unnest(ids);
  return cid;
end $$;

-- One-to-one chats must never reuse a group conversation.
create or replace function start_chat(other_phone text) returns uuid language plpgsql security definer set search_path = public as $$
declare other uuid; cid uuid;
begin
  select id into other from profiles where phone = regexp_replace(other_phone, '\D', '', 'g');
  if other is null then raise exception 'No Chat Up user with that number'; end if;
  if other = auth.uid() then raise exception 'That is your own number'; end if;
  select a.conversation_id into cid from conversation_members a
    join conversation_members b on a.conversation_id = b.conversation_id
    join conversations c on c.id = a.conversation_id and not c.is_group
    where a.user_id = auth.uid() and b.user_id = other limit 1;
  if cid is null then
    insert into conversations default values returning id into cid;
    insert into conversation_members values (cid, auth.uid()), (cid, other);
  end if;
  return cid;
end $$;

drop function my_chats();
create function my_chats() returns table (
  conversation_id uuid, is_group boolean, other_name text, other_phone text, last_body text, last_at timestamptz,
  last_from_me boolean, unread int, other_last_read timestamptz)
language sql security definer stable set search_path = public as $$
  select m.conversation_id, c.is_group,
    case when c.is_group then c.name else p.name end,
    case when c.is_group then null else p.phone end,
    lm.label, lm.created_at, (lm.sender_id = auth.uid()),
    (select count(*)::int from messages x where x.conversation_id = m.conversation_id and x.sender_id <> auth.uid() and x.created_at > m.last_read_at),
    -- read by everyone else: the earliest read time among the other members
    (select min(o.last_read_at) from conversation_members o where o.conversation_id = m.conversation_id and o.user_id <> auth.uid())
  from conversation_members m
  join conversations c on c.id = m.conversation_id
  left join lateral (
    select o.user_id from conversation_members o where o.conversation_id = m.conversation_id and o.user_id <> m.user_id limit 1) first_other on not c.is_group
  left join profiles p on p.id = first_other.user_id
  left join lateral (
    select coalesce(x.body, case when x.audio_path is not null then 'Voice note' else 'Photo' end) as label, x.created_at, x.sender_id
    from messages x where x.conversation_id = m.conversation_id order by x.created_at desc limit 1) lm on true
  where m.user_id = auth.uid()
  order by lm.created_at desc nulls last
$$;

-- ===== 008_safety_groups_replies_status.sql =====
-- Run once in the Supabase SQL Editor after 007_groups.sql.
-- Adds: group management, blocking, number-lookup limits, reply and delete-for-everyone,
-- status audience and "viewed by", and safe account deletion support.

------------------------------------------------------------------ history for new group members
alter table conversation_members add column joined_at timestamptz not null default now();
update conversation_members m set joined_at = c.created_at from conversations c where c.id = m.conversation_id;

------------------------------------------------------------------ blocking
create table blocks (
  blocker uuid not null references profiles on delete cascade default auth.uid(),
  blocked uuid not null references profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);
alter table blocks enable row level security;
create policy "see own blocks" on blocks for select to authenticated using (blocker = auth.uid());
create policy "block someone" on blocks for insert to authenticated with check (blocker = auth.uid());
create policy "unblock someone" on blocks for delete to authenticated using (blocker = auth.uid());

create function is_blocked_between(a uuid, b uuid) returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from blocks where (blocker = a and blocked = b) or (blocker = b and blocked = a))
$$;

-- In a one-to-one chat, nobody can send once either person has blocked the other.
create function can_message(cid uuid) returns boolean language sql security definer stable set search_path = public as $$
  select not exists (
    select 1 from conversations c
    join conversation_members o on o.conversation_id = c.id and o.user_id <> auth.uid()
    where c.id = cid and not c.is_group and is_blocked_between(o.user_id, auth.uid()))
$$;

------------------------------------------------------------------ replies and delete for everyone
alter table messages add column reply_to bigint references messages(id) on delete set null;
alter table messages add column deleted_at timestamptz;
alter table messages alter column sender_id drop not null;            -- kept as "deleted account" when a person leaves
alter table messages drop constraint messages_sender_id_fkey;
alter table messages add constraint messages_sender_id_fkey foreign key (sender_id) references profiles on delete set null;
alter table messages drop constraint messages_content_check;
alter table messages add constraint messages_content_check
  check (body is not null or image_path is not null or audio_path is not null or deleted_at is not null);

create function member_since(cid uuid) returns timestamptz language sql security definer stable set search_path = public as $$
  select joined_at from conversation_members where conversation_id = cid and user_id = auth.uid()
$$;
create function reply_ok(rid bigint, cid uuid) returns boolean language sql security definer stable set search_path = public as $$
  select rid is null or exists (select 1 from messages where id = rid and conversation_id = cid)
$$;

drop policy "members read messages" on messages;
create policy "members read messages" on messages for select to authenticated
  using (is_member(conversation_id) and created_at >= member_since(conversation_id));
drop policy "members send messages" on messages;
create policy "members send messages" on messages for insert to authenticated
  with check (sender_id = auth.uid() and is_member(conversation_id) and can_message(conversation_id) and reply_ok(reply_to, conversation_id));

-- Clears the message but keeps the row, so replies still point somewhere. Returns file paths so the app can delete the files.
create function delete_message(mid bigint) returns text[] language plpgsql security definer set search_path = public as $$
declare paths text[];
begin
  select array_remove(array[image_path, audio_path], null) into paths from messages where id = mid and sender_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'You can only delete your own messages'; end if;
  update messages set body = null, image_path = null, audio_path = null, deleted_at = now() where id = mid and sender_id = auth.uid();
  return paths;
end $$;

-- Lets a person remove the photo or voice file they uploaded. (owner_id is the uploader on current Supabase Storage; check yours.)
create policy "delete own chat files" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-images' and owner_id = (select auth.uid()::text));

------------------------------------------------------------------ number-lookup limit (100 per hour per person)
create table lookup_log (
  user_id uuid not null references profiles on delete cascade default auth.uid(),
  at timestamptz not null default now()
);
create index on lookup_log (user_id, at);
create index on lookup_log (at);
alter table lookup_log enable row level security;   -- no policies: only the functions below touch it

create function check_lookup_rate(n int default 1) returns void language plpgsql security definer set search_path = public as $$
declare c int;
begin
  delete from lookup_log where at < now() - interval '1 day';
  select count(*) into c from lookup_log where user_id = auth.uid() and at > now() - interval '1 hour';
  if c + n > 100 then raise exception 'Too many number lookups. Try again in an hour.'; end if;
  insert into lookup_log (user_id) select auth.uid() from generate_series(1, n);
end $$;

------------------------------------------------------------------ start_chat and create_group (rate limit and blocks)
create or replace function start_chat(other_phone text) returns uuid language plpgsql security definer set search_path = public as $$
declare other uuid; cid uuid;
begin
  perform check_lookup_rate(1);
  select id into other from profiles where phone = regexp_replace(other_phone, '\D', '', 'g');
  if other is null then raise exception 'No Chat Up user with that number'; end if;
  if other = auth.uid() then raise exception 'That is your own number'; end if;
  if exists (select 1 from blocks where blocker = auth.uid() and blocked = other) then raise exception 'You blocked this person. Unblock them first.'; end if;
  if exists (select 1 from blocks where blocker = other and blocked = auth.uid()) then raise exception 'No Chat Up user with that number'; end if;
  select a.conversation_id into cid from conversation_members a
    join conversation_members b on a.conversation_id = b.conversation_id
    join conversations c on c.id = a.conversation_id and not c.is_group
    where a.user_id = auth.uid() and b.user_id = other limit 1;
  if cid is null then
    insert into conversations default values returning id into cid;
    insert into conversation_members (conversation_id, user_id) values (cid, auth.uid()), (cid, other);
  end if;
  return cid;
end $$;

create or replace function create_group(group_name text, member_phones text[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid; ids uuid[]; missing text; clean text[]; n text := btrim(group_name); me_phone text;
begin
  if n is null or n = '' or length(n) > 40 then raise exception 'Give the group a name of 1 to 40 characters'; end if;
  select phone into me_phone from profiles where id = auth.uid();
  select array_agg(distinct d) into clean from (select regexp_replace(p, '\D', '', 'g') d from unnest(member_phones) p) x where d <> '' and d is distinct from me_phone;
  if clean is null then raise exception 'Add at least 2 people'; end if;
  perform check_lookup_rate(array_length(clean, 1));
  select array_agg(id) into ids from profiles where phone = any(clean) and not is_blocked_between(id, auth.uid());
  select string_agg('+' || c, ', ') into missing from unnest(clean) c
    where not exists (select 1 from profiles where phone = c and id = any(coalesce(ids, '{}'::uuid[])));
  if missing is not null then raise exception 'Not on Chat Up yet, or not available: %', missing; end if;
  if coalesce(array_length(ids, 1), 0) < 2 then raise exception 'Add at least 2 other people'; end if;
  if array_length(ids, 1) > 49 then raise exception 'A group can have up to 50 people including you'; end if;
  insert into conversations (is_group, name, created_by) values (true, n, auth.uid()) returning id into cid;
  insert into conversation_members (conversation_id, user_id) select cid, auth.uid() union select cid, unnest(ids);
  return cid;
end $$;

------------------------------------------------------------------ group management (the creator is the admin)
create function add_group_members(cid uuid, member_phones text[]) returns void language plpgsql security definer set search_path = public as $$
declare ids uuid[]; clean text[]; missing text; cnt int;
begin
  if not exists (select 1 from conversations where id = cid and is_group and created_by = auth.uid()) then raise exception 'Only the group admin can add people'; end if;
  select array_agg(distinct d) into clean from (select regexp_replace(p, '\D', '', 'g') d from unnest(member_phones) p) x where d <> '';
  if clean is null then raise exception 'Enter a phone number'; end if;
  perform check_lookup_rate(array_length(clean, 1));
  select array_agg(id) into ids from profiles where phone = any(clean) and not is_blocked_between(id, auth.uid());
  select string_agg('+' || c, ', ') into missing from unnest(clean) c
    where not exists (select 1 from profiles where phone = c and id = any(coalesce(ids, '{}'::uuid[])));
  if missing is not null then raise exception 'Not on Chat Up yet, or not available: %', missing; end if;
  select count(*) into cnt from (select user_id from conversation_members where conversation_id = cid union select unnest(ids)) x;
  if cnt > 50 then raise exception 'A group can have up to 50 people'; end if;
  insert into conversation_members (conversation_id, user_id) select cid, unnest(ids) on conflict do nothing;
end $$;

create function remove_group_member(cid uuid, member_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from conversations where id = cid and is_group and created_by = auth.uid()) then raise exception 'Only the group admin can remove people'; end if;
  if member_id = auth.uid() then raise exception 'Use Leave group to leave'; end if;
  delete from conversation_members where conversation_id = cid and user_id = member_id;
end $$;

create function rename_group(cid uuid, new_name text) returns void language plpgsql security definer set search_path = public as $$
begin
  if btrim(new_name) = '' or length(btrim(new_name)) > 40 then raise exception 'Give the group a name of 1 to 40 characters'; end if;
  update conversations set name = btrim(new_name) where id = cid and is_group and created_by = auth.uid();
  if not found then raise exception 'Only the group admin can rename the group'; end if;
end $$;

create function leave_group(cid uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from conversations where id = cid and is_group) then raise exception 'You can only leave a group'; end if;
  delete from conversation_members where conversation_id = cid and user_id = auth.uid();
  if exists (select 1 from conversations where id = cid and created_by = auth.uid()) then   -- hand over admin to the longest-standing member
    update conversations set created_by = (select user_id from conversation_members where conversation_id = cid order by joined_at limit 1) where id = cid;
  end if;
  if not exists (select 1 from conversation_members where conversation_id = cid) then delete from conversations where id = cid; end if;
end $$;

-- Used before deleting an account, so no group is left without an admin.
create function leave_all_groups() returns void language plpgsql security definer set search_path = public as $$
declare g uuid;
begin
  for g in select m.conversation_id from conversation_members m join conversations c on c.id = m.conversation_id where m.user_id = auth.uid() and c.is_group loop
    perform leave_group(g);
  end loop;
end $$;

-- People you share a chat with (not blocked): used to pick a status audience.
create function my_contacts() returns table (user_id uuid, name text, phone text) language sql security definer stable set search_path = public as $$
  select distinct p.id, p.name, p.phone from conversation_members a
  join conversation_members b on a.conversation_id = b.conversation_id and b.user_id <> a.user_id
  join profiles p on p.id = b.user_id
  where a.user_id = auth.uid() and not is_blocked_between(p.id, auth.uid())
  order by 2
$$;

------------------------------------------------------------------ chat list (history from join date, deleted label)
create or replace function my_chats() returns table (
  conversation_id uuid, is_group boolean, other_name text, other_phone text, last_body text, last_at timestamptz,
  last_from_me boolean, unread int, other_last_read timestamptz)
language sql security definer stable set search_path = public as $$
  select m.conversation_id, c.is_group,
    case when c.is_group then c.name else p.name end,
    case when c.is_group then null else p.phone end,
    lm.label, lm.created_at, (lm.sender_id = auth.uid()),
    (select count(*)::int from messages x where x.conversation_id = m.conversation_id and x.sender_id <> auth.uid()
       and x.created_at > m.last_read_at and x.created_at >= m.joined_at and x.deleted_at is null),
    (select min(o.last_read_at) from conversation_members o where o.conversation_id = m.conversation_id and o.user_id <> auth.uid())
  from conversation_members m
  join conversations c on c.id = m.conversation_id
  left join lateral (
    select o.user_id from conversation_members o where o.conversation_id = m.conversation_id and o.user_id <> m.user_id limit 1) first_other on not c.is_group
  left join profiles p on p.id = first_other.user_id
  left join lateral (
    select case when x.deleted_at is not null then 'This message was deleted'
                else coalesce(x.body, case when x.audio_path is not null then 'Voice note' else 'Photo' end) end as label,
           x.created_at, x.sender_id
    from messages x where x.conversation_id = m.conversation_id and x.created_at >= m.joined_at
    order by x.created_at desc limit 1) lm on true
  where m.user_id = auth.uid()
  order by lm.created_at desc nulls last
$$;

------------------------------------------------------------------ status audience and viewers
alter table statuses add column audience text not null default 'all' check (audience in ('all', 'except', 'only'));

create table status_audience (
  status_id bigint not null references statuses on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  primary key (status_id, user_id)
);
alter table status_audience enable row level security;

create function own_status(sid bigint) returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from statuses where id = sid and user_id = auth.uid())
$$;
create policy "owner reads audience" on status_audience for select to authenticated using (own_status(status_id));

create function can_view_status(sid bigint) returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from statuses s where s.id = sid and s.expires_at > now() and (
      s.user_id = auth.uid() or (
        can_see_user(s.user_id) and not is_blocked_between(s.user_id, auth.uid()) and (
          s.audience = 'all'
          or (s.audience = 'except' and not exists (select 1 from status_audience a where a.status_id = s.id and a.user_id = auth.uid()))
          or (s.audience = 'only' and exists (select 1 from status_audience a where a.status_id = s.id and a.user_id = auth.uid()))))))
$$;

drop policy "see statuses of chat partners" on statuses;
create policy "see allowed statuses" on statuses for select to authenticated using (expires_at > now() and can_view_status(id));
drop policy "post own status" on statuses;   -- posting now goes through post_status(), so audience and status are saved together

create function post_status(p_kind text, p_body text, p_media_path text, p_bg int, p_duration int, p_audience text, p_audience_ids uuid[])
returns bigint language plpgsql security definer set search_path = public as $$
declare sid bigint;
begin
  if p_audience not in ('all', 'except', 'only') then raise exception 'Unknown audience'; end if;
  if p_audience = 'only' and coalesce(array_length(p_audience_ids, 1), 0) = 0 then raise exception 'Choose who can see this status'; end if;
  if p_media_path is not null and (storage.foldername(p_media_path))[1] <> auth.uid()::text then raise exception 'Media must be your own upload'; end if;
  insert into statuses (user_id, kind, body, media_path, bg, duration_s, audience)
    values (auth.uid(), p_kind, p_body, p_media_path, coalesce(p_bg, 0), p_duration, p_audience) returning id into sid;
  if p_audience <> 'all' then
    insert into status_audience (status_id, user_id) select sid, unnest(p_audience_ids) on conflict do nothing;
  end if;
  return sid;
end $$;

create table status_views (
  status_id bigint not null references statuses on delete cascade,
  viewer_id uuid not null references profiles on delete cascade default auth.uid(),
  viewed_at timestamptz not null default now(),
  primary key (status_id, viewer_id)
);
alter table status_views enable row level security;
create policy "record my view" on status_views for insert to authenticated
  with check (viewer_id = auth.uid() and can_view_status(status_id) and not own_status(status_id));
create policy "see views" on status_views for select to authenticated using (viewer_id = auth.uid() or own_status(status_id));

-- Status photos and videos follow the same audience rules as the status itself.
create function can_view_status_media(obj text) returns boolean language sql security definer stable set search_path = public as $$
  select (storage.foldername(obj))[1] = auth.uid()::text
      or exists (select 1 from statuses s where s.media_path = obj and can_view_status(s.id))
$$;
drop policy "see partners status media" on storage.objects;
create policy "see allowed status media" on storage.objects for select to authenticated
  using (bucket_id = 'status-media' and can_view_status_media(name));

-- ===== 009_calls.sql =====
-- 009: one-to-one voice and video calls (call log + ringing state).
-- Run after 008. The live audio/video itself runs on LiveKit; see functions/call/index.ts.
create table calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations on delete cascade,
  caller uuid not null references profiles on delete cascade,
  callee uuid not null references profiles on delete cascade,
  kind text not null check (kind in ('voice','video')),
  status text not null default 'ringing' check (status in ('ringing','answered','declined','missed','ended','cancelled')),
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);
create index calls_caller_idx on calls (caller, started_at desc);
create index calls_callee_idx on calls (callee, started_at desc);
alter table calls enable row level security;
-- People can read their own calls. All changes go through the functions below.
create policy "read own calls" on calls for select using (auth.uid() in (caller, callee));

-- Start a call in a one-to-one chat. Refuses groups, non-members and blocked pairs.
create function start_call(cid uuid, call_kind text) returns calls language plpgsql security definer set search_path = public as $$
declare other uuid; c calls;
begin
  if not is_member(cid) then raise exception 'Not in this chat'; end if;
  if (select is_group from conversations where id = cid) then raise exception 'Calls are for one-to-one chats only'; end if;
  if not can_message(cid) then raise exception 'You can''t call this person'; end if;
  select user_id into other from conversation_members where conversation_id = cid and user_id <> auth.uid();
  if other is null then raise exception 'No one to call'; end if;
  if is_blocked_between(other, auth.uid()) then raise exception 'You can''t call this person'; end if;
  -- one live call at a time per person
  update calls set status = 'missed', ended_at = now()
    where status = 'ringing' and started_at < now() - interval '60 seconds' and (caller = auth.uid() or callee = auth.uid());
  if exists (select 1 from calls where status in ('ringing','answered') and (caller in (auth.uid(), other) or callee in (auth.uid(), other))) then
    raise exception 'One of you is already on a call';
  end if;
  insert into calls (conversation_id, caller, callee, kind) values (cid, auth.uid(), other, call_kind) returning * into c;
  return c;
end $$;

-- Callee answers, declines; caller cancels; either ends.
create function update_call(call_id uuid, new_status text) returns calls language plpgsql security definer set search_path = public as $$
declare c calls;
begin
  select * into c from calls where id = call_id and auth.uid() in (caller, callee) for update;
  if not found then raise exception 'Call not found'; end if;
  if new_status = 'answered' and auth.uid() = c.callee and c.status = 'ringing' then
    update calls set status = 'answered', answered_at = now() where id = call_id returning * into c;
  elsif new_status = 'declined' and auth.uid() = c.callee and c.status = 'ringing' then
    update calls set status = 'declined', ended_at = now() where id = call_id returning * into c;
  elsif new_status = 'cancelled' and auth.uid() = c.caller and c.status = 'ringing' then
    update calls set status = 'cancelled', ended_at = now() where id = call_id returning * into c;
  elsif new_status = 'missed' and c.status = 'ringing' then
    update calls set status = 'missed', ended_at = now() where id = call_id returning * into c;
  elsif new_status = 'ended' and c.status = 'answered' then
    update calls set status = 'ended', ended_at = now() where id = call_id returning * into c;
  end if;
  return c;
end $$;

-- Recent list for the Calls tab, newest first, with the other person's name.
create function my_calls() returns table (id uuid, conversation_id uuid, other_id uuid, other_name text, other_phone text,
  kind text, status text, outgoing boolean, started_at timestamptz, answered_at timestamptz, ended_at timestamptz)
language sql security definer stable set search_path = public as $$
  select c.id, c.conversation_id, o.id, o.name, o.phone, c.kind, c.status, c.caller = auth.uid(), c.started_at, c.answered_at, c.ended_at
  from calls c join profiles o on o.id = case when c.caller = auth.uid() then c.callee else c.caller end
  where auth.uid() in (c.caller, c.callee)
  order by c.started_at desc limit 100
$$;

-- Clear the call log for me only (the other person keeps theirs): hide by deleting is not allowed,
-- so keep a per-user "cleared before" time.
alter table profiles add column calls_cleared_at timestamptz;
create function clear_call_log() returns void language sql security definer set search_path = public as $$
  update profiles set calls_cleared_at = now() where id = auth.uid()
$$;
create or replace function my_calls() returns table (id uuid, conversation_id uuid, other_id uuid, other_name text, other_phone text,
  kind text, status text, outgoing boolean, started_at timestamptz, answered_at timestamptz, ended_at timestamptz)
language sql security definer stable set search_path = public as $$
  select c.id, c.conversation_id, o.id, o.name, o.phone, c.kind, c.status, c.caller = auth.uid(), c.started_at, c.answered_at, c.ended_at
  from calls c join profiles o on o.id = case when c.caller = auth.uid() then c.callee else c.caller end
  where auth.uid() in (c.caller, c.callee)
    and c.started_at > coalesce((select calls_cleared_at from profiles where id = auth.uid()), 'epoch')
  order by c.started_at desc limit 100
$$;

alter publication supabase_realtime add table calls;

-- ===== 010_call_encryption.sql =====
-- 010: end-to-end encrypted calls. Run after 009.
-- Each phone makes its own key pair and uploads only the PUBLIC key. The caller makes a random
-- call key, locks it with the callee's public key, and stores the locked copy here. The server
-- never sees the call key, so it can't listen in. LiveKit only carries already-encrypted media.
alter table profiles add column public_key text;
alter table calls add column key_box text;

create function set_public_key(k text) returns void language plpgsql security definer set search_path = public as $$
begin
  if k is null or length(k) <> 44 then raise exception 'Bad key'; end if;
  update profiles set public_key = k where id = auth.uid();
end $$;

-- Replaces start_call from 009: a call can't start without the locked call key.
drop function start_call(uuid, text);
create function start_call(cid uuid, call_kind text, call_key_box text) returns calls language plpgsql security definer set search_path = public as $$
declare other uuid; c calls;
begin
  if call_key_box is null or length(call_key_box) < 40 then raise exception 'Calls must be encrypted'; end if;
  if not is_member(cid) then raise exception 'Not in this chat'; end if;
  if (select is_group from conversations where id = cid) then raise exception 'Calls are for one-to-one chats only'; end if;
  if not can_message(cid) then raise exception 'You can''t call this person'; end if;
  select user_id into other from conversation_members where conversation_id = cid and user_id <> auth.uid();
  if other is null then raise exception 'No one to call'; end if;
  if is_blocked_between(other, auth.uid()) then raise exception 'You can''t call this person'; end if;
  update calls set status = 'missed', ended_at = now()
    where status = 'ringing' and started_at < now() - interval '60 seconds' and (caller = auth.uid() or callee = auth.uid());
  if exists (select 1 from calls where status in ('ringing','answered') and (caller in (auth.uid(), other) or callee in (auth.uid(), other))) then
    raise exception 'One of you is already on a call';
  end if;
  insert into calls (conversation_id, caller, callee, kind, key_box) values (cid, auth.uid(), other, call_kind, call_key_box) returning * into c;
  return c;
end $$;

-- ===== 011_encrypted_chats.sql =====
-- 011: end-to-end encrypted text, photos and voice notes in one-to-one chats. Run after 010.
-- The sender's phone locks the text with the other person's public key (see 010 for keys).
-- The server stores only the locked text in messages.enc. A photo or voice note is locked with its own
-- random file key before upload; that key travels inside messages.enc, so the file in storage is unreadable.
-- Group chats and statuses are NOT encrypted yet. Old plain messages and files stay readable.
alter table messages add column enc text;

alter table messages drop constraint messages_content_check;
alter table messages add constraint messages_content_check
  check (body is not null or enc is not null or image_path is not null or audio_path is not null or deleted_at is not null);

-- One-to-one chats must use encryption for text. Groups can't use it yet, so they keep plain text.
create function require_encrypted_text() returns trigger language plpgsql security definer set search_path = public as $$
declare grp boolean;
begin
  select is_group into grp from conversations where id = new.conversation_id;
  if not grp and new.body is not null then raise exception 'Messages in one-to-one chats must be encrypted'; end if;
  if grp and new.enc is not null then raise exception 'Group chats are not encrypted yet'; end if;
  return new;
end $$;
create trigger messages_require_enc before insert on messages for each row execute function require_encrypted_text();

-- Deleting for everyone also removes the locked text.
create or replace function delete_message(mid bigint) returns text[] language plpgsql security definer set search_path = public as $$
declare paths text[];
begin
  select array_remove(array[image_path, audio_path], null) into paths from messages where id = mid and sender_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'You can only delete your own messages'; end if;
  update messages set body = null, enc = null, image_path = null, audio_path = null, deleted_at = now() where id = mid and sender_id = auth.uid();
  return paths;
end $$;

-- Chat list: the server can't read encrypted text, so it returns the locked last message (last_enc)
-- and the other person's id, and the phone unlocks it.
drop function my_chats();
create function my_chats() returns table (
  conversation_id uuid, is_group boolean, other_name text, other_phone text, last_body text, last_at timestamptz,
  last_from_me boolean, unread int, other_last_read timestamptz, other_id uuid, last_enc text)
language sql security definer stable set search_path = public as $$
  select m.conversation_id, c.is_group,
    case when c.is_group then c.name else p.name end,
    case when c.is_group then null else p.phone end,
    lm.label, lm.created_at, (lm.sender_id = auth.uid()),
    (select count(*)::int from messages x where x.conversation_id = m.conversation_id and x.sender_id <> auth.uid()
       and x.created_at > m.last_read_at and x.created_at >= m.joined_at and x.deleted_at is null),
    (select min(o.last_read_at) from conversation_members o where o.conversation_id = m.conversation_id and o.user_id <> auth.uid()),
    case when c.is_group then null else first_other.user_id end,
    lm.enc
  from conversation_members m
  join conversations c on c.id = m.conversation_id
  left join lateral (
    select o.user_id from conversation_members o where o.conversation_id = m.conversation_id and o.user_id <> m.user_id limit 1) first_other on not c.is_group
  left join profiles p on p.id = first_other.user_id
  left join lateral (
    select case when x.deleted_at is not null then 'This message was deleted'
                when x.enc is not null and x.image_path is not null then 'Photo'
                when x.enc is not null and x.audio_path is not null then 'Voice note'
                when x.enc is not null then null
                else coalesce(x.body, case when x.audio_path is not null then 'Voice note' else 'Photo' end) end as label,
           x.enc, x.created_at, x.sender_id
    from messages x where x.conversation_id = m.conversation_id and x.created_at >= m.joined_at
    order by x.created_at desc limit 1) lm on true
  where m.user_id = auth.uid()
  order by lm.created_at desc nulls last
$$;

-- ===== 012_encrypted_groups.sql =====
-- 012: end-to-end encrypted text, photos and voice notes in GROUP chats. Run after 011.
-- Each message gets a random content key. The sender's phone locks the message with that key and
-- locks a copy of the content key for every current member with their public key (messages.enc_keys).
-- People removed from a group get no key for new messages; people added later get no key for old ones.
alter table messages add column enc_keys jsonb;

create or replace function require_encrypted_text() returns trigger language plpgsql security definer set search_path = public as $$
declare grp boolean;
begin
  select is_group into grp from conversations where id = new.conversation_id;
  if new.body is not null then raise exception 'Messages must be encrypted'; end if;
  if grp and new.enc is not null and new.enc_keys is null then raise exception 'Group messages need a key for each member'; end if;
  if not grp and new.enc_keys is not null then raise exception 'Unexpected group keys'; end if;
  return new;
end $$;

-- Deleting for everyone also removes the keys.
create or replace function delete_message(mid bigint) returns text[] language plpgsql security definer set search_path = public as $$
declare paths text[];
begin
  select array_remove(array[image_path, audio_path], null) into paths from messages where id = mid and sender_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'You can only delete your own messages'; end if;
  update messages set body = null, enc = null, enc_keys = null, image_path = null, audio_path = null, deleted_at = now() where id = mid and sender_id = auth.uid();
  return paths;
end $$;

-- Chat list: also return the locked keys and sender of the last message so the phone can unlock it.
drop function my_chats();
create function my_chats() returns table (
  conversation_id uuid, is_group boolean, other_name text, other_phone text, last_body text, last_at timestamptz,
  last_from_me boolean, unread int, other_last_read timestamptz, other_id uuid, last_enc text, last_keys jsonb, last_sender uuid)
language sql security definer stable set search_path = public as $$
  select m.conversation_id, c.is_group,
    case when c.is_group then c.name else p.name end,
    case when c.is_group then null else p.phone end,
    lm.label, lm.created_at, (lm.sender_id = auth.uid()),
    (select count(*)::int from messages x where x.conversation_id = m.conversation_id and x.sender_id <> auth.uid()
       and x.created_at > m.last_read_at and x.created_at >= m.joined_at and x.deleted_at is null),
    (select min(o.last_read_at) from conversation_members o where o.conversation_id = m.conversation_id and o.user_id <> auth.uid()),
    case when c.is_group then null else first_other.user_id end,
    lm.enc, lm.enc_keys, lm.sender_id
  from conversation_members m
  join conversations c on c.id = m.conversation_id
  left join lateral (
    select o.user_id from conversation_members o where o.conversation_id = m.conversation_id and o.user_id <> m.user_id limit 1) first_other on not c.is_group
  left join profiles p on p.id = first_other.user_id
  left join lateral (
    select case when x.deleted_at is not null then 'This message was deleted'
                when x.enc is not null and x.image_path is not null then 'Photo'
                when x.enc is not null and x.audio_path is not null then 'Voice note'
                when x.enc is not null then null
                else coalesce(x.body, case when x.audio_path is not null then 'Voice note' else 'Photo' end) end as label,
           x.enc, x.enc_keys, x.created_at, x.sender_id
    from messages x where x.conversation_id = m.conversation_id and x.created_at >= m.joined_at
    order by x.created_at desc limit 1) lm on true
  where m.user_id = auth.uid()
  order by lm.created_at desc nulls last
$$;

-- ===== 013_encrypted_status.sql =====
-- 013: end-to-end encrypted TEXT and PHOTO statuses. Run after 012.
-- The poster's phone locks the status for each person allowed to see it (same method as group chats).
-- VIDEO statuses are NOT encrypted yet: big files need streaming encryption that only a native library can do.
alter table statuses add column enc text;
alter table statuses add column enc_keys jsonb;

-- Replace the old "text needs a body" rule: encrypted text has no plain body.
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'statuses'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%media_path%' loop
    execute format('alter table statuses drop constraint %I', c);
  end loop;
end $$;
alter table statuses add constraint statuses_content_check
  check ((kind = 'text' and (body is not null or enc is not null)) or (kind <> 'text' and media_path is not null));

drop function post_status(text, text, text, int, int, text, uuid[]);
create function post_status(p_kind text, p_body text, p_media_path text, p_bg int, p_duration int, p_audience text, p_audience_ids uuid[], p_enc text default null, p_enc_keys jsonb default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare sid bigint;
begin
  if p_audience not in ('all', 'except', 'only') then raise exception 'Unknown audience'; end if;
  if p_audience = 'only' and coalesce(array_length(p_audience_ids, 1), 0) = 0 then raise exception 'Choose who can see this status'; end if;
  if p_media_path is not null and (storage.foldername(p_media_path))[1] <> auth.uid()::text then raise exception 'Media must be your own upload'; end if;
  -- Text and photos must be encrypted. Videos may still be plain for now.
  if p_kind in ('text', 'photo') and (p_enc is null or p_enc_keys is null or p_body is not null) then raise exception 'Text and photo statuses must be encrypted'; end if;
  insert into statuses (user_id, kind, body, media_path, bg, duration_s, audience, enc, enc_keys)
    values (auth.uid(), p_kind, p_body, p_media_path, coalesce(p_bg, 0), p_duration, p_audience, p_enc, p_enc_keys) returning id into sid;
  if p_audience <> 'all' then
    insert into status_audience (status_id, user_id) select sid, unnest(p_audience_ids) on conflict do nothing;
  end if;
  return sid;
end $$;

-- ===== 014_key_backup.sql =====
-- 014: encrypted backup of each person's private key, so a new phone can read old messages. Run after 013.
-- The phone locks its private key with a passphrase only the person knows (scrypt + secretbox) and
-- stores the locked blob here. The server can't open it. Forgetting the passphrase means no recovery.
create table key_backups (
  user_id uuid primary key references profiles on delete cascade default auth.uid(),
  blob text not null,
  updated_at timestamptz not null default now()
);
alter table key_backups enable row level security;
create policy "own backup read" on key_backups for select to authenticated using (user_id = auth.uid());
create policy "own backup insert" on key_backups for insert to authenticated with check (user_id = auth.uid());
create policy "own backup update" on key_backups for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own backup delete" on key_backups for delete to authenticated using (user_id = auth.uid());

-- ===== 015_reports.sql =====
-- 015: report people, messages and statuses. Run after 014.
-- Chats are end-to-end encrypted, so the server cannot read them. A report only contains
-- what the reporter chooses to send: the reason, and optionally the text they can see.
create table reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles on delete cascade default auth.uid(),
  reported_id uuid references profiles on delete set null,
  message_id uuid,
  status_id uuid,
  reason text not null check (reason in ('spam','harassment','illegal','impersonation','other')),
  excerpt text check (excerpt is null or length(excerpt) <= 2000),
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
alter table reports enable row level security;
-- People can file reports and see only their own. Nobody else can read them from the app:
-- review them in the Supabase dashboard (Table editor > reports).
create policy "file report" on reports for insert to authenticated
  with check (reporter_id = auth.uid() and reported_id is distinct from auth.uid());
create policy "see own reports" on reports for select to authenticated using (reporter_id = auth.uid());
create index reports_open on reports (created_at) where handled_at is null;
