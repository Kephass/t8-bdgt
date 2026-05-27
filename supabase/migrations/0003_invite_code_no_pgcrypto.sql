-- Family Budget — drop pgcrypto dependency from create_household
--
-- gen_random_bytes() lives in pgcrypto, which isn't enabled by default on
-- this project. gen_random_uuid() IS built into Postgres 13+ (we already
-- rely on it for the households.id default), so we reuse it.
--
-- 8 hex chars from a UUID gives ~32 bits of entropy = 4.3B codes. The
-- loop already handles the (vanishingly rare) collision case.

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
  loop
    code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.households where invite_code = code);
  end loop;

  insert into public.households (invite_code) values (code) returning id into hid;
  insert into public.household_members (household_id, user_id) values (hid, auth.uid());
  return hid;
end;
$$;
