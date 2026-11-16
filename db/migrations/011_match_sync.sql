-- The mailbox of an online match: the second road between its two phones, used when their direct connection breaks
-- (a minimised app, a few seconds without internet, a move from Wi-Fi to the mobile network).
-- id: a hash only the two phones can compute. seat: 0 (host) or 1 (guest). i: the running number of a message.
-- Rows are short-lived: the function forgets everything older than a day.
create table if not exists match_sync_msgs (
  id text not null,
  seat smallint not null,
  i integer not null,
  msg jsonb not null,
  created_at timestamptz not null default now(),
  primary key (id, seat, i)
);
create index if not exists match_sync_msgs_created_idx on match_sync_msgs(created_at);

-- Per player of a match: how many of the other player's messages they have, and when they last reached the server.
create table if not exists match_sync_seats (
  id text not null,
  seat smallint not null,
  ack integer not null default 0,
  seen_at timestamptz not null default now(),
  primary key (id, seat)
);
create index if not exists match_sync_seats_seen_idx on match_sync_seats(seen_at);
