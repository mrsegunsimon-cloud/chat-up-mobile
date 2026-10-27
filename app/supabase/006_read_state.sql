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
