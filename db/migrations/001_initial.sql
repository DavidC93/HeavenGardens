create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  password_hash text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists user_sessions_user_id_idx on user_sessions(user_id);
create index if not exists user_sessions_expires_at_idx on user_sessions(expires_at);

create table if not exists password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists password_reset_tokens_user_id_idx on password_reset_tokens(user_id);
create index if not exists password_reset_tokens_expires_at_idx on password_reset_tokens(expires_at);

create table if not exists cards (
  id text primary key,
  kind text not null check (kind in ('monster', 'spell')),
  name text not null,
  cost integer not null default 0 check (cost >= 0),
  image_url text,
  emoji text,
  accent text,
  race text,
  war text,
  attack integer,
  defense integer,
  hp integer,
  speed integer,
  target text,
  effect text,
  amount integer,
  description text,
  abilities jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cards_kind_active_idx on cards(kind, active);

create table if not exists user_decks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  name text not null default 'Default',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists user_deck_cards (
  deck_id uuid not null references user_decks(id) on delete cascade,
  card_id text not null references cards(id),
  quantity integer not null check (quantity >= 0 and quantity <= 4),
  primary key (deck_id, card_id)
);

create index if not exists user_decks_user_id_idx on user_decks(user_id);

