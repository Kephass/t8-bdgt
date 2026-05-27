-- Family Budget — initial schema
-- Multi-household model: each household has many members (authenticated users).
-- All app data is scoped by household_id and protected by RLS.

-- ────────────────────────────────────────────────────────────────────────────
-- Tables
-- ────────────────────────────────────────────────────────────────────────────

create table public.households (
  id            uuid primary key default gen_random_uuid(),
  invite_code   text unique not null,
  income        numeric not null default 0,
  savings       numeric not null default 0,
  currency      text not null default '€',
  cofidis       boolean not null default true,
  created_at    timestamptz not null default now()
);

create table public.household_members (
  household_id  uuid not null references public.households(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  joined_at     timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index idx_household_members_user on public.household_members(user_id);

create table public.categories (
  household_id  uuid not null references public.households(id) on delete cascade,
  id            text not null,                    -- stable client id: 'rent', 'eneco', etc.
  "group"       text not null check ("group" in ('fixed','essentials','discretionary')),
  name          text not null,
  note          text,
  budget        numeric not null default 0,
  locked        boolean not null default false,
  icon          text,
  color         text,
  sort_order    integer not null default 0,
  primary key (household_id, id)
);

create table public.entries (
  id            text primary key,                 -- client-generated newId()
  household_id  uuid not null references public.households(id) on delete cascade,
  category_id   text not null,
  month_key     text not null,                    -- 'YYYY-MM'
  amount        numeric not null,
  note          text,
  spent_on      date not null,
  created_at    timestamptz not null default now(),
  foreign key (household_id, category_id) references public.categories(household_id, id) on delete cascade
);
create index idx_entries_household_month on public.entries(household_id, month_key);

create table public.meals (
  household_id  uuid not null references public.households(id) on delete cascade,
  on_date       date not null,
  dinner        text,
  breakfast     text,
  lunch         text,
  notes         text,
  primary key (household_id, on_date)
);

create table public.shopping_items (
  id            text primary key,                 -- client-generated newId()
  household_id  uuid not null references public.households(id) on delete cascade,
  month_key     text not null,
  week_num      smallint not null check (week_num between 1 and 4),
  item          text not null,
  done          boolean not null default false,
  created_at    timestamptz not null default now()
);
create index idx_shopping_household on public.shopping_items(household_id, month_key, week_num);

create table public.budget_overrides (
  household_id  uuid not null references public.households(id) on delete cascade,
  month_key     text not null,
  category_id   text not null,
  amount        numeric not null,
  primary key (household_id, month_key, category_id),
  foreign key (household_id, category_id) references public.categories(household_id, id) on delete cascade
);

-- ────────────────────────────────────────────────────────────────────────────
-- Grants (new tables are no longer auto-exposed to the Data API per the
-- 2026-04-28 breaking change — must grant explicitly).
-- ────────────────────────────────────────────────────────────────────────────

grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on
  public.households,
  public.household_members,
  public.categories,
  public.entries,
  public.meals,
  public.shopping_items,
  public.budget_overrides
to authenticated;

-- anon role gets nothing on tables — the app is auth-only.

-- ────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- Pattern: a row is visible iff the caller is a member of its household.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.categories        enable row level security;
alter table public.entries           enable row level security;
alter table public.meals             enable row level security;
alter table public.shopping_items    enable row level security;
alter table public.budget_overrides  enable row level security;

-- households: caller can see/update their own household; insert/delete go through SECURITY DEFINER functions.
create policy households_select on public.households
  for select to authenticated
  using (exists (
    select 1 from public.household_members hm
    where hm.household_id = households.id and hm.user_id = auth.uid()
  ));

create policy households_update on public.households
  for update to authenticated
  using (exists (
    select 1 from public.household_members hm
    where hm.household_id = households.id and hm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.household_members hm
    where hm.household_id = households.id and hm.user_id = auth.uid()
  ));

-- household_members: caller can read members of households they belong to;
-- insert/delete go through SECURITY DEFINER functions (join/create).
create policy hm_select on public.household_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.household_members hm2
      where hm2.household_id = household_members.household_id
        and hm2.user_id = auth.uid()
    )
  );

-- Generic helper: a single policy macro per table for all CRUD on household-scoped rows.
-- (Postgres needs separate policies per CMD; we duplicate the USING/WITH CHECK clause.)

-- categories
create policy categories_all on public.categories
  for all to authenticated
  using (exists (
    select 1 from public.household_members hm
    where hm.household_id = categories.household_id and hm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.household_members hm
    where hm.household_id = categories.household_id and hm.user_id = auth.uid()
  ));

-- entries
create policy entries_all on public.entries
  for all to authenticated
  using (exists (
    select 1 from public.household_members hm
    where hm.household_id = entries.household_id and hm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.household_members hm
    where hm.household_id = entries.household_id and hm.user_id = auth.uid()
  ));

-- meals
create policy meals_all on public.meals
  for all to authenticated
  using (exists (
    select 1 from public.household_members hm
    where hm.household_id = meals.household_id and hm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.household_members hm
    where hm.household_id = meals.household_id and hm.user_id = auth.uid()
  ));

-- shopping_items
create policy shopping_all on public.shopping_items
  for all to authenticated
  using (exists (
    select 1 from public.household_members hm
    where hm.household_id = shopping_items.household_id and hm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.household_members hm
    where hm.household_id = shopping_items.household_id and hm.user_id = auth.uid()
  ));

-- budget_overrides
create policy overrides_all on public.budget_overrides
  for all to authenticated
  using (exists (
    select 1 from public.household_members hm
    where hm.household_id = budget_overrides.household_id and hm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.household_members hm
    where hm.household_id = budget_overrides.household_id and hm.user_id = auth.uid()
  ));

-- ────────────────────────────────────────────────────────────────────────────
-- Bootstrap RPCs
-- These intentionally elevate privilege so users can:
--   - create a household (insert a row they wouldn't otherwise be able to)
--   - join an existing household by invite code (insert a member row they wouldn't otherwise be able to)
-- search_path is pinned for safety.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.create_household()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  hid  uuid;
  code text;
begin
  -- 8-char uppercase invite code, retry on the (extremely rare) collision.
  loop
    code := upper(substring(encode(gen_random_bytes(6), 'hex'), 1, 8));
    exit when not exists (select 1 from public.households where invite_code = code);
  end loop;

  insert into public.households (invite_code) values (code) returning id into hid;
  insert into public.household_members (household_id, user_id) values (hid, auth.uid());
  return hid;
end;
$$;

create or replace function public.join_household(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  hid uuid;
begin
  select id into hid from public.households where invite_code = upper(p_invite_code);
  if hid is null then
    raise exception 'Invalid invite code';
  end if;
  insert into public.household_members (household_id, user_id)
    values (hid, auth.uid())
    on conflict do nothing;
  return hid;
end;
$$;

revoke execute on function public.create_household()           from public;
revoke execute on function public.join_household(text)         from public;
grant  execute on function public.create_household()           to authenticated;
grant  execute on function public.join_household(text)         to authenticated;
