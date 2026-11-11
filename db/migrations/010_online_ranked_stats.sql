-- Ranked games online (each side reports; a win counts once the other side confirms or stays silent), the player's
-- statistics and recent games (with the opponent of an online game), a nickname every player chooses once, and the
-- Unity player id of each account (to add a past opponent as a friend).

alter table app_users add column if not exists nickname_chosen boolean not null default false;
alter table app_users add column if not exists ugs_player_id text;

-- what kind of game: practice | ranked | casual | friend (older rows: null, read from mode)
alter table match_results add column if not exists kind text;
alter table match_results add column if not exists opponent_name text;
alter table match_results add column if not exists ai_level integer;
create index if not exists match_results_recent_idx on match_results(user_id, created_at desc);
-- both players of an online game report under the same key: the opponent is the other row with that key
create index if not exists match_results_key_idx on match_results(match_key);

-- an online ranked game's claimed result ("win" | "draw") waiting for the other side, and since when
alter table ranked_matches add column if not exists claim text;
alter table ranked_matches add column if not exists claimed_at timestamptz;
create index if not exists ranked_matches_key_idx on ranked_matches(match_key);
