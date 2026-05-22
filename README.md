# Family Budget

A single-file, mobile-first budgeting app built for the Oduro Fosu – Dos Santos Lima household. All data lives in `localStorage` on this device; nothing leaves the browser.

## Run

Just open the file:

```sh
open Felix_Budget_App.html
```

Or via the bundled dev server (lets you reload while editing):

```sh
python3 -m http.server 8765
# then visit http://localhost:8765/Felix_Budget_App.html
```

## What's inside

- **Home** — hero balance, income / spent / saved stats, and the three category groups (Non-negotiables, Food & essentials, Discretionary).
- **Budget** — the full per-category list with progress bars.
- **Food** — week-at-a-time dinner planner plus a 4-week shopping list scoped to the current month.
- **Settings** — income, savings, currency, and lockable recurring obligations.

## Features

- **Per-month budgets.** Editing a category's amount only affects the active month; the global default stays put. Set a custom value back to the default and the override self-cleans.
- **Re-plan month.** Auto-balances flex categories within `income − savings − locked` using a tight / medium / comfortable strategy. Writes per-month overrides — other months are untouched.
- **Quick log.** A floating "+" picks a category and opens the entry form pre-focused.
- **Right-click / long-press a shopping item** to duplicate or move it to another weekly bucket.
- **Month picker.** Pill-style top header with `< >` step chevrons plus a sheet listing every month with logged spend.
- **Dinner planner.** Tap the centre pill to jump back to "this week"; today's row is highlighted, past days dimmed, future days at full opacity.

## Architecture

Everything in one HTML file: CSS, markup, and a vanilla-JS script organised as

```
user event ──▶ action ──▶ commit(mutator) ──▶ save() + render()
```

| Module    | Role                                                                   |
| --------- | ---------------------------------------------------------------------- |
| `state`   | persisted source of truth (mirrors localStorage)                        |
| `view`    | ephemeral UI position (which month / week / screen is shown)           |
| `commit`  | the only state-mutation entry point: mutate, persist, re-render        |
| `derive`  | pure selectors over state — `budget`, `spent`, `totals`, `progress`, … |
| `fmt`     | money formatting                                                       |
| `render*` | pure projections of state → DOM                                        |
| Actions   | every user command; each ends in `commit(…)`                           |

No build step, no dependencies beyond Google Fonts.

## Data

Persisted in `localStorage` under the key `familyBudget.v1`. To wipe everything, use **Settings → Wipe all data**.

## Repo layout

```
.
├── Felix_Budget_App.html   # the entire app
├── .claude/launch.json     # dev-server config for the Claude Code preview
├── .gitignore
└── README.md
```
