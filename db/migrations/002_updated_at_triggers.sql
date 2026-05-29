create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists app_users_set_updated_at on app_users;
create trigger app_users_set_updated_at
before update on app_users
for each row execute function set_updated_at();

drop trigger if exists cards_set_updated_at on cards;
create trigger cards_set_updated_at
before update on cards
for each row execute function set_updated_at();

drop trigger if exists user_decks_set_updated_at on user_decks;
create trigger user_decks_set_updated_at
before update on user_decks
for each row execute function set_updated_at();

