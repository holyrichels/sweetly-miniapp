create table public.web_login_codes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.web_login_codes enable row level security;
revoke all on table public.web_login_codes from public, anon, authenticated;
grant all on table public.web_login_codes to service_role;

create table public.web_login_code_attempts (
  client_hash text primary key check (client_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count > 0)
);

create index web_login_code_attempts_window_started_at_idx
  on public.web_login_code_attempts (window_started_at);

alter table public.web_login_code_attempts enable row level security;
revoke all on table public.web_login_code_attempts from public, anon, authenticated;
grant all on table public.web_login_code_attempts to service_role;

create or replace function public.issue_web_login_code(
  p_user_id uuid,
  p_code_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  issued boolean := false;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid code hash' using errcode = '22023';
  end if;

  insert into public.web_login_codes as existing (
    user_id,
    code_hash,
    expires_at,
    used_at,
    created_at
  )
  values (
    p_user_id,
    p_code_hash,
    pg_catalog.now() + interval '10 minutes',
    null,
    pg_catalog.now()
  )
  on conflict (user_id) do update
    set code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        used_at = null,
        created_at = excluded.created_at
    where existing.created_at <= pg_catalog.now() - interval '30 seconds'
  returning true into issued;

  return coalesce(issued, false);
end;
$$;

create or replace function public.consume_web_login_code(p_code_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  consumed_user_id uuid;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  update public.web_login_codes
  set used_at = pg_catalog.now()
  where code_hash = p_code_hash
    and used_at is null
    and expires_at > pg_catalog.now()
  returning user_id into consumed_user_id;

  return consumed_user_id;
end;
$$;

create or replace function public.record_web_login_code_attempt(p_client_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_attempt_count integer;
begin
  if p_client_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid client hash' using errcode = '22023';
  end if;

  insert into public.web_login_code_attempts as existing (
    client_hash,
    window_started_at,
    attempt_count
  )
  values (p_client_hash, pg_catalog.now(), 1)
  on conflict (client_hash) do update
    set window_started_at = case
          when existing.window_started_at <= pg_catalog.now() - interval '15 minutes'
            then pg_catalog.now()
          else existing.window_started_at
        end,
        attempt_count = case
          when existing.window_started_at <= pg_catalog.now() - interval '15 minutes'
            then 1
          else existing.attempt_count + 1
        end
  returning attempt_count into current_attempt_count;

  delete from public.web_login_code_attempts
  where window_started_at <= pg_catalog.now() - interval '24 hours';

  return current_attempt_count <= 10;
end;
$$;

create or replace function public.revoke_web_login_code(p_code_hash text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.web_login_codes
  set used_at = pg_catalog.now()
  where code_hash = p_code_hash
    and used_at is null;
$$;

revoke all on function public.issue_web_login_code(uuid, text) from public, anon, authenticated;
revoke all on function public.consume_web_login_code(text) from public, anon, authenticated;
revoke all on function public.record_web_login_code_attempt(text) from public, anon, authenticated;
revoke all on function public.revoke_web_login_code(text) from public, anon, authenticated;

grant execute on function public.issue_web_login_code(uuid, text) to service_role;
grant execute on function public.consume_web_login_code(text) to service_role;
grant execute on function public.record_web_login_code_attempt(text) to service_role;
grant execute on function public.revoke_web_login_code(text) to service_role;
