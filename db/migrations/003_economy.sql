-- Economy: coins and golden apples, the card collection, card shards per rarity, and a ledger of every change.

create table if not exists player_wallets (
  user_id uuid primary key references app_users(id) on delete cascade,
  coins integer not null default 0 check (coins >= 0),
  apples integer not null default 0 check (apples >= 0),
  starter_granted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- count = copies owned; locked = starter copies that can never be disenchanted
create table if not exists player_cards (
  user_id uuid not null references app_users(id) on delete cascade,
  card_id text not null references cards(id),
  count integer not null default 0 check (count >= 0),
  locked integer not null default 0 check (locked >= 0 and locked <= count),
  updated_at timestamptz not null default now(),
  primary key (user_id, card_id)
);

create index if not exists player_cards_user_id_idx on player_cards(user_id);

create table if not exists player_shards (
  user_id uuid not null references app_users(id) on delete cascade,
  rarity text not null check (rarity in ('bronze', 'silver', 'gold', 'emerald', 'diamond')),
  amount integer not null default 0 check (amount >= 0),
  primary key (user_id, rarity)
);

-- every economy change (grant, pack, reward, craft, disenchant), for support and abuse checks
create table if not exists economy_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists economy_events_user_kind_idx on economy_events(user_id, kind, created_at desc);

-- one reward per match and player
create table if not exists match_rewards (
  user_id uuid not null references app_users(id) on delete cascade,
  match_key text not null,
  mode text not null,
  result text not null,
  coins integer not null,
  created_at timestamptz not null default now(),
  primary key (user_id, match_key)
);

create index if not exists match_rewards_user_time_idx on match_rewards(user_id, created_at desc);
