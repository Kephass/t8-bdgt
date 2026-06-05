-- Family Budget — "Needs & Wants" list
--
-- A standing, household-shared wishlist of things to buy (NOT month/week
-- scoped like shopping_items). Each row is open until checked off, at which
-- point `bought_at` records the day it was purchased.
--
-- Mirrors the shopping_items table + the household-scoped RLS pattern
-- (see 0001_init.sql / 0002_fix_rls_recursion.sql).

create table public.wants (
  id            text primary key,                 -- client-generated newId()
  household_id  uuid not null references public.households(id) on delete cascade,
  item          text not null,
  done          boolean not null default false,
  bought_at     date,                             -- set when checked off, null while open
  created_at    timestamptz not null default now()
);
create index idx_wants_household on public.wants(household_id);

-- New tables aren't auto-exposed to the Data API (2026-04-28 change) — grant.
grant select, insert, update, delete on public.wants to authenticated;

alter table public.wants enable row level security;

-- A row is visible/editable iff the caller belongs to its household.
create policy wants_all on public.wants
  for all to authenticated
  using      (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
