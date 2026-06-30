-- Family Budget — per-month savings-target overrides
-- The household's default savings target lives on households.savings. A row
-- here overrides it for a single month, mirroring income_overrides (0006).

create table public.savings_overrides (
  household_id  uuid not null references public.households(id) on delete cascade,
  month_key     text not null,                    -- 'YYYY-MM'
  amount        numeric not null,
  primary key (household_id, month_key)
);

-- New tables aren't auto-exposed to the Data API — grant explicitly.
grant select, insert, update, delete on public.savings_overrides to authenticated;

alter table public.savings_overrides enable row level security;

-- Visible/writable iff the caller belongs to the row's household.
create policy savings_overrides_all on public.savings_overrides
  for all to authenticated
  using (exists (
    select 1 from public.household_members hm
    where hm.household_id = savings_overrides.household_id and hm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.household_members hm
    where hm.household_id = savings_overrides.household_id and hm.user_id = auth.uid()
  ));
