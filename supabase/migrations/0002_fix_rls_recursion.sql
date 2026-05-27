-- Family Budget — fix infinite RLS recursion
--
-- Problem: `hm_select` on household_members checked membership via an
--   EXISTS subquery against household_members itself. Postgres tries to
--   apply RLS to the subquery's lookups → infinite recursion. This also
--   poisoned every OTHER policy (categories, entries, …) because they
--   each EXISTS into household_members.
--
-- Fix: a SECURITY DEFINER helper does the membership check. It bypasses
--   RLS on the inner read (running as function owner), but still uses
--   auth.uid() from the caller's JWT, so the check is per-user.
--
-- All household-scoped policies are dropped + recreated against the helper.

create or replace function public.is_household_member(hid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.household_members
    where household_id = hid and user_id = auth.uid()
  );
$$;

revoke execute on function public.is_household_member(uuid) from public;
grant  execute on function public.is_household_member(uuid) to authenticated;

-- Drop the recursive policies + their siblings.
drop policy if exists households_select on public.households;
drop policy if exists households_update on public.households;
drop policy if exists hm_select         on public.household_members;
drop policy if exists categories_all    on public.categories;
drop policy if exists entries_all       on public.entries;
drop policy if exists meals_all         on public.meals;
drop policy if exists shopping_all      on public.shopping_items;
drop policy if exists overrides_all     on public.budget_overrides;

-- Recreate against the helper. Same semantics, no recursion.

create policy households_select on public.households
  for select to authenticated
  using (public.is_household_member(id));

create policy households_update on public.households
  for update to authenticated
  using      (public.is_household_member(id))
  with check (public.is_household_member(id));

create policy hm_select on public.household_members
  for select to authenticated
  using (public.is_household_member(household_id));

create policy categories_all on public.categories
  for all to authenticated
  using      (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

create policy entries_all on public.entries
  for all to authenticated
  using      (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

create policy meals_all on public.meals
  for all to authenticated
  using      (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

create policy shopping_all on public.shopping_items
  for all to authenticated
  using      (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

create policy overrides_all on public.budget_overrides
  for all to authenticated
  using      (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
