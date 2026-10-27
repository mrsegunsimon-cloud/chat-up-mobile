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
