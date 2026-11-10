-- Ranked play: points and leagues per season, ranked matches (a started match without a result becomes a loss),
-- one-time league and season rewards, and public nicknames for the leaderboard. Settings live in app_settings 'ranks'
-- (the server has built-in defaults, so no row is needed).

create table if not exists player_ranks (
  user_id uuid primary key references app_users(id) on delete cascade,
  season text not null,
  points integer not null default 0,
  best_league integer not null default 1,      -- the highest league reached this season (its rewards were paid)
  streak integer not null default 0,           -- > 0: wins in a row, < 0: losses in a row
  reached_at timestamptz not null default now(), -- when the points last went up (ties on the leaderboard)
  games integer not null default 0,
  wins integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists player_ranks_board_idx on player_ranks(season, points desc, reached_at asc);

create table if not exists ranked_matches (
  user_id uuid not null references app_users(id) on delete cascade,
  match_key text not null,
  mode text not null default 'ai',
  season text not null,
  ai_level integer,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  result text,                 -- win | lose | draw | abandoned (no result came: counted as a loss)
  turns integer,
  points_before integer,
  points_after integer,
  delta integer,
  primary key (user_id, match_key)
);

create index if not exists ranked_matches_open_idx on ranked_matches(user_id, started_at) where finished_at is null;

-- League-up rewards (once per season) and season rewards, keyed so each is paid once.
create table if not exists rank_rewards (
  user_id uuid not null references app_users(id) on delete cascade,
  reward_key text not null,    -- "<season>:league:<n>" | "<season>:season"
  detail jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, reward_key)
);

-- Changes that are not matches: admin adjustments and season resets.
create table if not exists rank_events (
  id bigserial primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  kind text not null,
  detail jsonb not null,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists rank_events_user_idx on rank_events(user_id, created_at desc);

-- The public name on the leaderboard (never the sign-in name): generated on first ranked play, editable.
alter table app_users add column if not exists nickname text;
create unique index if not exists app_users_nickname_idx on app_users(lower(nickname));
