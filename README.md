# Family Budget

A mobile-first budgeting app built for the Oduro Fosu – Dos Santos Lima household. Local-first: every change hits `localStorage` instantly, then syncs to Supabase in the background so the whole household shares one budget across devices.

## Run

First copy `config.example.js` to `config.js` and fill in your Supabase project URL + publishable key (Supabase dashboard → Settings → API). On first load you sign in — or sign up and create a new household / join one with an invite code.

Open `index.html` directly in a browser:

```sh
open index.html
```

Or via the bundled dev server (so reloads pick up edits to `app.js` / `styles.css`):

```sh
python3 -m http.server 8765
# then visit http://localhost:8765/index.html
```

> Editing a JS file? Bump its `?v=N` query in `index.html` (e.g. `app.js?v=29`) so browsers fetch the new copy instead of a stale cached one.

## What's inside

- **Home** — hero spend chart, tappable income / spent / savings stats (tap **Income** or **Savings target** to set them for the active month), and the three category groups (Non-negotiables, Food & essentials, Discretionary).
- **Budget** — the full per-category list with progress bars.
- **Food** — week-at-a-time dinner planner plus a 4-week shopping list scoped to the current month.
- **Settings** — default income, default savings, currency, lockable recurring obligations, and household members / invite code.

## Features

- **Per-month budgets.** Editing a category's amount only affects the active month; the global default stays put. Set a custom value back to the default and the override self-cleans.
- **Per-month income & savings.** Tap the **Income** or **Savings target** tile on Home to set a value for just the active month — handy when income varies month to month. Settings holds the global default each un-customised month falls back to; set a month back to the default and the override self-cleans, same as budgets.
- **Re-plan month.** Auto-balances flex categories within `income − savings − locked` using a tight / medium / comfortable strategy. Writes per-month overrides — including that month's income and savings — so other months are untouched.
- **Quick log.** A floating "+" picks a category and opens the entry form pre-focused.
- **Right-click / long-press a shopping item** to duplicate or move it to another weekly bucket.
- **Month picker.** Pill-style top header with `< >` step chevrons plus a sheet listing every month with logged spend.
- **Dinner planner.** Tap the centre pill to jump back to "this week"; today's row is highlighted, past days dimmed, future days at full opacity.

## Architecture

Vanilla HTML / CSS / JS, no build step. The only runtime dependencies are Google Fonts and the Supabase JS client, both loaded from a CDN. The script in `app.js` is organised around a one-way data flow:

```
user event ──▶ action ──▶ commit(mutator) ──▶ save() + render()
                    └────▶ sync.* ──▶ Supabase (background)
```

| Module    | Role                                                                            |
| --------- | ------------------------------------------------------------------------------- |
| `state`   | persisted source of truth (mirrors localStorage)                                |
| `view`    | ephemeral UI position (which month / week / screen is shown)                    |
| `commit`  | the only state-mutation entry point: mutate, persist, re-render                 |
| `derive`  | pure selectors over state — `budget`, `income`, `savings`, `spent`, `totals`, … |
| `fmt`     | money formatting                                                                |
| `render*` | pure projections of state → DOM                                                 |
| Actions   | every user command; each ends in `commit(…)` (+ a background `sync.*`)          |

Cloud auth + sync live in `cloud.js` (Supabase client, `auth.*`, `sync.*`, `hydrate()`); the sign-in UX lives in `auth-ui.js`. Sync is fire-and-forget after each `commit()` — local always wins first, failures surface on the sync indicator and never block the UI.

## Data

Mirrored in `localStorage` under the key `familyBudget.v2` and synced to Supabase (Postgres). Every table is scoped to a household and protected by row-level security, so members share data and nobody sees another household's. Per-month values live in their own tables: `budget_overrides`, `income_overrides`, `savings_overrides`. Schema + policies are in `supabase/migrations/`. **Settings → Wipe local data & sign out** clears this device's local state and signs you out — the shared cloud household stays intact (an admin deletes it via Supabase to wipe shared data).

## Repo layout

```
.
├── index.html              # markup + modal sheets + bottom nav
├── styles.css              # theme tokens, all components
├── app.js                  # the single-file architecture above
├── cloud.js                # Supabase auth + local-first sync layer
├── auth-ui.js              # sign-in / sign-up modal + household wiring
├── defaults.js             # seed categories for a new household
├── migrations.js           # in-browser upgrades of older localStorage shapes
├── config.example.js       # copy to config.js with your Supabase creds
├── supabase/migrations/    # Postgres schema + RLS policies
├── .claude/launch.json     # dev-server config for the Claude Code preview
├── .gitignore
└── README.md
```
