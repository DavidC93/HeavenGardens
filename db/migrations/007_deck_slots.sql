-- Several saved decks per player: 10 free, up to 10 more bought with golden apples (deck_slots = bought so far).
-- A deck may be an unfinished draft; only one deck per player is active (the one played with).
alter table player_wallets add column if not exists deck_slots integer not null default 0 check (deck_slots >= 0);
alter table user_decks add column if not exists position integer not null default 0;
-- before this migration every player had at most one deck ("Default"), so this cannot fail on existing rows
create unique index if not exists user_decks_one_active_idx on user_decks(user_id) where is_active;
