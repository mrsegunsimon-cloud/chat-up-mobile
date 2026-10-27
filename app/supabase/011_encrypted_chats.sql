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
