-- 015: report people, messages and statuses. Run after 014.
-- Chats are end-to-end encrypted, so the server cannot read them. A report only contains
-- what the reporter chooses to send: the reason, and optionally the text they can see.
create table reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles on delete cascade default auth.uid(),
  reported_id uuid references profiles on delete set null,
  message_id uuid,
  status_id uuid,
  reason text not null check (reason in ('spam','harassment','illegal','impersonation','other')),
  excerpt text check (excerpt is null or length(excerpt) <= 2000),
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
alter table reports enable row level security;
-- People can file reports and see only their own. Nobody else can read them from the app:
-- review them in the Supabase dashboard (Table editor > reports).
create policy "file report" on reports for insert to authenticated
  with check (reporter_id = auth.uid() and reported_id is distinct from auth.uid());
create policy "see own reports" on reports for select to authenticated using (reporter_id = auth.uid());
create index reports_open on reports (created_at) where handled_at is null;
