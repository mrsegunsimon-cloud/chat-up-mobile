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
