-- Family Budget — household admin RPCs
--
-- All three run as SECURITY DEFINER so they can read auth.users / write
-- household_members regardless of the caller's RLS view. Each one starts
-- by resolving the caller's household via auth.uid() — there's no
-- caller-provided household_id, so a user can only act on their own
-- household.

-- rotate_invite_code() — generate a new 8-char code for the caller's
-- household. Loops on the (vanishingly rare) collision case, same as
-- create_household().
create or replace function public.rotate_invite_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  hid  uuid;
  code text;
begin
  select hm.household_id into hid
    from public.household_members hm
   where hm.user_id = auth.uid()
   limit 1;
  if hid is null then
    raise exception 'No household';
  end if;
  loop
    code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.households where invite_code = code);
  end loop;
  update public.households set invite_code = code where id = hid;
  return code;
end;
$$;
revoke execute on function public.rotate_invite_code() from public;
grant  execute on function public.rotate_invite_code() to authenticated;

-- list_household_members() — return {user_id, email, joined_at, is_me}
-- rows for everyone in the caller's household. Reads auth.users which
-- isn't normally exposed; SECURITY DEFINER lets us join through.
create or replace function public.list_household_members()
returns table(user_id uuid, email text, joined_at timestamptz, is_me boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp, auth
as $$
declare
  hid uuid;
begin
  select hm.household_id into hid
    from public.household_members hm
   where hm.user_id = auth.uid()
   limit 1;
  if hid is null then return; end if;
  return query
    select u.id, u.email::text, hm.joined_at, (u.id = auth.uid())
      from public.household_members hm
      join auth.users u on u.id = hm.user_id
     where hm.household_id = hid
     order by hm.joined_at;
end;
$$;
revoke execute on function public.list_household_members() from public;
grant  execute on function public.list_household_members() to authenticated;

-- remove_household_member(target) — kick another user out of the
-- caller's household. Refuses self-removal (use sign-out for that).
create or replace function public.remove_household_member(target uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  hid uuid;
begin
  if target = auth.uid() then
    raise exception 'Use sign-out to remove yourself';
  end if;
  select hm.household_id into hid
    from public.household_members hm
   where hm.user_id = auth.uid()
   limit 1;
  if hid is null then raise exception 'No household'; end if;
  delete from public.household_members
   where household_id = hid and user_id = target;
end;
$$;
revoke execute on function public.remove_household_member(uuid) from public;
grant  execute on function public.remove_household_member(uuid) to authenticated;
