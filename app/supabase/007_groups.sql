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
