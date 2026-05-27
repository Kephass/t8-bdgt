/* Supabase credentials for the t8-bdgt project.

   These ship to every client — the publishable key is explicitly designed
   for that. RLS in the database is what enforces access, not the key.
   If you ever introduce a server-side `sb_secret_…` key, it does NOT
   belong here — put it in a server-only env (Edge Function secret, etc.). */

window.SUPABASE_URL             = 'https://rahzogpxxnmloyqobjix.supabase.co';
window.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_nwb5NUsfVnpMivvPpoYvkQ_PJfqXN35';
