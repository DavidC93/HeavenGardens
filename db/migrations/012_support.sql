-- Messages to support, sent from the game's help screen (players and guests).
-- status: open | done. The back office lists them and marks them done.
create table if not exists support_requests (
  id bigserial primary key,
  user_id uuid references app_users(id) on delete set null,
  name text not null,
  email text,
  message text not null,
  app_version text,
  platform text,
  device text,
  language text,
  status text not null default 'open',
  handled_by uuid references app_users(id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists support_requests_status_idx on support_requests(status, created_at desc);
