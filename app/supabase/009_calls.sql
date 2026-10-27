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
