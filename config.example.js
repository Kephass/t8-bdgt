/* Copy this file to `config.js` and fill in your Supabase project credentials.
   `config.js` is gitignored so credentials never land in the repo.

   Find these values in your Supabase dashboard:
     URL  → Settings → API → Project URL
     KEY  → Settings → API → Project API keys → publishable (sb_publishable_…)

   Publishable keys are the modern replacement for legacy anon keys — they're
   safe to ship in client code (that's their purpose) and can be rotated
   independently of the project's secret key. RLS in the database is what
   actually protects your data, not the key itself. */

window.SUPABASE_URL             = 'https://YOUR-PROJECT-REF.supabase.co';
window.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_YOUR-KEY';
