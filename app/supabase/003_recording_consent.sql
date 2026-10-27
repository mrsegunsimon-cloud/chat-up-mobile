-- Run once in the Supabase SQL Editor after 002_voice_push.sql.
-- Each person decides whether others may screen record their video on calls. Off by default.
alter table profiles add column allow_recording boolean not null default false;
-- Chat partners can already read each other's profile row, so a call screen can check this flag.
