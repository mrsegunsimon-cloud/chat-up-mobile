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
