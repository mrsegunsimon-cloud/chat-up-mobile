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
