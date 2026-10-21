-- Decks for the computer opponent, made in the back office. config:
--   { "fixed":  { "<card id>": copies, ... }                       cards always in the deck (gods included)
--     "random": { "monsters": n, "spells": n, "gods": n,             drawn anew for every game
--                 "rarities": ["bronze", ...], "godRarities": [...] } }
create table if not exists ai_decks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  config jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references app_users(id) on delete set null
);

-- Every finished game (rewarded or not): the computer's difficulty follows the number of games played against it.
create table if not exists match_results (
  user_id uuid not null references app_users(id) on delete cascade,
  match_key text not null,
  mode text not null,
  result text not null,
  turns integer not null,
  created_at timestamptz not null default now(),
  primary key (user_id, match_key)
);

create index if not exists match_results_user_mode_idx on match_results(user_id, mode);

-- The 10 difficulty levels: a level applies up to maxGames finished games against the computer (the last has none),
-- and plays the chosen deck (none = the built-in random deck).
insert into app_settings (key, value)
values ('ai_levels', '{"levels": [
  {"level": 1, "maxGames": 5}, {"level": 2, "maxGames": 10}, {"level": 3, "maxGames": 20}, {"level": 4, "maxGames": 30},
  {"level": 5, "maxGames": 50}, {"level": 6, "maxGames": 80}, {"level": 7, "maxGames": 120}, {"level": 8, "maxGames": 160},
  {"level": 9, "maxGames": 200}, {"level": 10, "maxGames": null}
]}'::jsonb)
on conflict (key) do nothing;
