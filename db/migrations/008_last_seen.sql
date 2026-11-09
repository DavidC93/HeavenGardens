-- When each player last used the app, and which build they had (for following testers and support).
-- Written by currentUser at most once every few minutes per player; null = not seen since this migration.
alter table app_users add column if not exists last_seen_at timestamptz;
alter table app_users add column if not exists last_client text;
create index if not exists app_users_last_seen_idx on app_users(last_seen_at desc nulls last);
