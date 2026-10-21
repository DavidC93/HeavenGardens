-- Settings the owner changes from the back office without a deploy.
-- client_versions: per platform, the oldest app build (Android versionCode) that may still play ("min": older builds
-- must update) and the build players are invited to update to ("recommended": a dismissible prompt).
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_users(id) on delete set null
);

insert into app_settings (key, value)
values ('client_versions', '{"android": {"min": 0, "recommended": 0}}'::jsonb)
on conflict (key) do nothing;
