-- Family Budget — per-month category snapshots
-- Categories used to be a single global list (public.categories) shared by every
-- month, so editing one month retroactively changed the others. Each month now
-- owns its own snapshot here: same shape as categories, keyed additionally by
-- month_key. The old `categories` table is kept as the base/seed template and as
-- the source for the one-time client migration (see cloud.js hydrate).

create table public.monthly_categories (
  household_id  uuid not null references public.households(id) on delete cascade,
  month_key     text not null,                    -- 'YYYY-MM'
  id            text not null,                    -- stable client id: 'rent', etc.
  "group"       text not null check ("group" in ('fixed','essentials','discretionary')),
  name          text not null,
  note          text,
  budget        numeric not null default 0,
  locked        boolean not null default false,
  icon          text,
  color         text,
  sort_order    integer not null default 0,
  primary key (household_id, month_key, id)
);

-- New tables aren't auto-exposed to the Data API — grant explicitly.
grant select, insert, update, delete on public.monthly_categories to authenticated;

alter table public.monthly_categories enable row level security;

-- Visible/writable iff the caller belongs to the row's household.
create policy monthly_categories_all on public.monthly_categories
  for all to authenticated
  using (exists (
    select 1 from public.household_members hm
    where hm.household_id = monthly_categories.household_id and hm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.household_members hm
    where hm.household_id = monthly_categories.household_id and hm.user_id = auth.uid()
  ));
