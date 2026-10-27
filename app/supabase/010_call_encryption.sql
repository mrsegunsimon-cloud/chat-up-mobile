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
