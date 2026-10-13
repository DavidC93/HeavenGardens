-- Accounts that sign in with a platform (Google Play Games now, Apple later) have no email or password.
alter table app_users alter column email drop not null;
alter table app_users alter column password_hash drop not null;

-- One row per way of signing in to an account (besides email + password, which stays on app_users).
create table if not exists user_identities (
  provider text not null check (provider in ('google_play', 'apple')),
  subject text not null,
  user_id uuid not null references app_users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  primary key (provider, subject),
  unique (user_id, provider)
);

create index if not exists user_identities_user_id_idx on user_identities(user_id);

-- Fixed-window request counters (see _lib/ratelimit.mjs); old windows are pruned as requests come in.
create table if not exists rate_limits (
  bucket text not null,
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket, key, window_start)
);

create index if not exists rate_limits_window_idx on rate_limits(window_start);

-- Errors and crashes reported by the app.
create table if not exists client_errors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app_users(id) on delete set null,
  app_version text,
  platform text,
  device text,
  kind text not null,
  message text not null,
  stack text,
  count integer not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists client_errors_created_idx on client_errors(created_at desc);

-- Golden apples bought in the store: one row per Google Play purchase token, so a purchase pays out once.
-- Kept (without the player) after an account is deleted, as the record of a payment.
create table if not exists iap_purchases (
  purchase_token text primary key,
  user_id uuid references app_users(id) on delete set null,
  store text not null default 'google_play',
  product_id text not null,
  order_id text,
  apples integer not null,
  created_at timestamptz not null default now()
);

create index if not exists iap_purchases_user_idx on iap_purchases(user_id, created_at desc);

-- "Watch an ad to double the reward": created when the ad starts, verified by AdMob's server-side callback,
-- paid once when the app claims it.
create table if not exists ad_rewards (
  nonce text primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  match_key text not null,
  coins integer not null,
  transaction_id text unique,
  verified_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, match_key)
);

create index if not exists ad_rewards_user_claimed_idx on ad_rewards(user_id, claimed_at desc);
