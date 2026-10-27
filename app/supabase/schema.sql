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

