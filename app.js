'use strict';
/* ============================================================================
   Family Budget — single-screen budgeting for the Oduro Fosu / Dos Santos Lima
   household. All data lives in localStorage on this device.

   Architecture — one-way data flow:

       user event ──▶ action ──▶ commit(mutator) ──▶ save() + render()

   • state    — single source of persisted truth (mirrors localStorage)
   • view     — ephemeral UI state (which month/week/screen is shown)
   • commit() — the only way state changes: mutate, persist, re-render
   • derive   — pure read-only selectors over state
   • fmt      — pure value formatting
   • render*  — pure projections of state → DOM
   • actions  — user-triggered commands; each ends in a commit() or modal op

   Companion files (loaded before this one — see index.html):
     • defaults.js   — window.DEFAULTS (seed config + categories)
     • migrations.js — runMigrations / migrateActuals / migrateShopping / seedRescueMonth
     • auth-ui.js    — auth-modal handlers + onAuthed() household wiring
     • cloud.js      — Supabase client, auth/sync API, hydrate()

   Modules below are ordered so every name is defined before it is used.
   ========================================================================== */

/* ── 1. Constants ────────────────────────────────────────────────────────── */

const STORE_KEY   = 'familyBudget.v2';
const LEGACY_KEYS = ['familyBudget.v1'];   // wiped on first boot of v2
const MONTH_RANGE = { back: 24, ahead: 6 };          // months reachable from the picker
const SNACK       = { visibleMs: 3500, transitionMs: 320 };  // keep transitionMs == .snack CSS
const SHOP_WEEK_START = { 1: 1, 2: 8, 3: 15, 4: 22 };  // week 4 runs to month-end

// Per-household seed values live in defaults.js → window.DEFAULTS.

/* ── 2. Tiny utilities ───────────────────────────────────────────────────── */

const $          = id => document.getElementById(id);
const newId      = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const escapeHtml = s  => (s || '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// Accept both `.` and `,` as decimal separator (Belgian/EU users type "12,34").
function parseAmount(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/* ── 3. Dates ────────────────────────────────────────────────────────────── */

const pad2      = n => String(n).padStart(2, '0');
const dayKey    = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthKey  = d => dayKey(d).slice(0, 7);
const today     = () => dayKey(new Date());
const thisMonth = () => monthKey(new Date());
/** Default date for a new entry in the viewed month: today when it's the
   current month, else the 15th — so the entry lands in the month on screen. */
const seedEntryDate = () => view.month === thisMonth() ? today() : `${view.month}-15`;

/** Friendly label for a 'YYYY-MM' key, e.g. 'May 2026'. */
const monthName = key =>
  new Date(key + '-15').toLocaleString('en-US', { month: 'long', year: 'numeric' });

/** 'YYYY-MM' shifted by `delta` months. */
function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 15));
}

/** Monday 00:00 of the week containing `date`. */
function mondayOf(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);   // Mon=0 … Sun=6
  d.setHours(0, 0, 0, 0);
  return d;
}

/* ── 4. Store: state, view, persistence, commit ──────────────────────────── */

// One-time wipe of pre-cloud localStorage. The new app is cloud-of-truth;
// any v1 leftovers would just confuse hydration.
for (const k of LEGACY_KEYS) localStorage.removeItem(k);

/** Was localStorage empty when we loaded? Captured before migrations write to it. */
const isFirstRun = localStorage.getItem(STORE_KEY) === null;

/** Persisted application state. Mutated only inside commit(). */
let state = load();

/** Ephemeral UI state — never persisted. */
const view = {
  screen:       'home',
  month:        thisMonth(),
  week:         mondayOf(new Date()),
  shopWeek:     '1',
  editId:       null,
  ctxId:        null,
  budgetFilter: 'all',   // all | fixed | essentials | discretionary
};

function blankState() {
  return {
    config:          { income: 0, savings: 0, currency: '€', cofidis: true },
    categories:      [],
    entries:         {},
    meals:           {},
    shopping:        {},
    budgetOverrides: {},
    flags:           {},
  };
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) return {
      ...blankState(), ...saved,
      config:          { ...blankState().config, ...(saved.config || {}) },
      categories:      saved.categories      || [],
      meals:           saved.meals           || {},
      shopping:        saved.shopping        || {},
      budgetOverrides: saved.budgetOverrides || {},
      flags:           saved.flags           || {},
    };
  } catch { /* corrupt → fall through to blank */ }
  return blankState();
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

/**
 * The single entry point for state changes. Mutates, persists, re-renders.
 * Pass `{ render:false }` for changes whose view is a live input
 * (typing a dinner note), where re-rendering would interrupt typing.
 */
function commit(mutate, { render: doRender = true } = {}) {
  mutate(state);
  save();
  if (doRender) render();
}

/* ── 5. Migrations + seeds: see migrations.js ────────────────────────────── */

/* ── 6. Derive: pure selectors over state ────────────────────────────────── */

const derive = {
  entries(catId, month = view.month) {
    return state.entries?.[month]?.[catId] || [];
  },
  spent(catId, month = view.month) {
    return derive.entries(catId, month).reduce((sum, e) => sum + (+e.amount || 0), 0);
  },

  /** Effective budget for a category in a month: per-month override or global default. */
  budget(cat, month = view.month) {
    if (!cat) return 0;
    if (cat.id === 'cofidis' && !state.config.cofidis) return 0;
    const o = state.budgetOverrides?.[month]?.[cat.id];
    return o != null ? +o : (+cat.budget || 0);
  },
  budgetById(catId, month) {
    return derive.budget(state.categories.find(c => c.id === catId), month);
  },
  hasOverride(catId, month = view.month) {
    return state.budgetOverrides?.[month]?.[catId] !== undefined;
  },

  /** Group totals + total spend for a month. */
  totals(month = view.month) {
    const t = { fixed: 0, ess: 0, disc: 0, spent: 0 };
    const bucket = { fixed: 'fixed', essentials: 'ess', discretionary: 'disc' };
    for (const cat of state.categories) {
      t[bucket[cat.group]] += derive.budget(cat, month);
      t.spent += derive.spent(cat.id, month);
    }
    t.budgeted = t.fixed + t.ess + t.disc;
    return t;
  },

  /** Inclusive [min,max] month keys the picker may travel to. */
  monthBounds() {
    return {
      min: shiftMonth(thisMonth(), -MONTH_RANGE.back),
      max: shiftMonth(thisMonth(),  MONTH_RANGE.ahead),
    };
  },

  /** Spend status of a budget line: { pct (capped 0..100), rawPct, status }. */
  progress(spent, budget) {
    const rawPct = budget > 0 ? Math.round(spent / budget * 100) : 0;
    const pct    = Math.min(100, rawPct);
    const status = spent > budget ? 'over' : pct >= 80 ? 'warn' : 'ok';
    return { pct, rawPct, status };
  },

  /** Calendar day range of a shopping-list week within a month. */
  shopWeekRange(week, month = view.month) {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const start = SHOP_WEEK_START[week];
    return { start, end: String(week) === '4' ? lastDay : start + 6 };
  },
};

/* ── 7. Format ───────────────────────────────────────────────────────────── */

/** Money, e.g. 1234.5 → '€1,234.5'; negatives use a real minus sign. */
function fmt(n) {
  const sign = n < 0 ? '−' : '';
  const abs  = Math.abs(n);
  const digits = abs % 1 ? 2 : 0;
  return sign + (state.config.currency || '€') +
    abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: 2 });
}

/* ── 8. Views: state → DOM ───────────────────────────────────────────────── */

function render() {
  renderHeader();
  renderHeaderPicker();
  renderHome();
  renderBudgetView();
  renderSetupView();
  renderFoodView();
  if (view.editId) renderEditSheet();
}

/** Greeting uses the signed-in user's first name (auth metadata). Falls back
   to the email's local-part, then a generic "there", so it never reads
   "Hi  —" before a name is set or while signed out behind the splash. */
function renderHeader() {
  const el = $('greeting');
  if (!el) return;
  const name = auth.firstName()
    || (cloud.session?.user?.email || '').split('@')[0]
    || 'there';
  el.textContent = `Hi ${name} —`;
}

function renderHeaderPicker() {
  $('monthLabel').textContent = monthName(view.month);
  const { min, max } = derive.monthBounds();
  $('monthPrev').disabled = view.month <= min;
  $('monthNext').disabled = view.month >= max;
}

function renderHome() {
  const t = derive.totals();
  const income  = +state.config.income  || 0;
  const savings = +state.config.savings || 0;
  const remaining = t.budgeted - t.spent;

  renderHomeHeroChart();

  $('statIncome').textContent = fmt(income);
  $('statSpent').textContent  = fmt(t.spent);
  $('statSaved').textContent  = fmt(savings);
  const delta = $('statSpentDelta');
  delta.textContent = remaining >= 0 ? `${fmt(remaining)} left` : `${fmt(-remaining)} over`;
  delta.className   = 'delta ' + (remaining >= 0 ? 'pos' : 'neg');

  $('categoryGroups').innerHTML =
    ['fixed','essentials','discretionary'].map(categoryGroupSummary).join('');

  renderSnapshotTiles();
}

/** Two side-by-side tiles below the categories card:
   1. Bills & utilities — how much of this month's fixed bills are still owed
      (fixed budgets minus what's already been logged), with a progress bar.
   2. Savings — the monthly target + an annualised "if kept" projection.
   The savings actuals aren't tracked yet so the bar is informational only. */
function renderSnapshotTiles() {
  const fixed = state.categories.filter(c => c.group === 'fixed');
  const fixedBudget = fixed.reduce((t, c) => t + derive.budget(c), 0);
  const fixedSpent  = fixed.reduce((t, c) => t + derive.spent(c.id), 0);
  const fixedLeft   = Math.max(0, fixedBudget - fixedSpent);
  const billsPct    = fixedBudget > 0 ? Math.min(100, (fixedSpent / fixedBudget) * 100) : 0;
  $('billsLeft').textContent      = `${fmt(fixedLeft)} left`;
  $('billsSub').textContent       = `${fmt(fixedSpent)} of ${fmt(fixedBudget)} paid`;
  $('billsBarFill').style.width   = `${billsPct.toFixed(1)}%`;

  // Surplus = income − total budgeted − monthly savings target. The same
  // "slack / over-spend" line the old Summary card showed: positive means
  // you'd finish the month with money left if you stuck to budgets.
  const income   = +state.config.income  || 0;
  const savings  = +state.config.savings || 0;
  const totals   = derive.totals();
  const surplus  = income - totals.budgeted - savings;
  const surplusAmtEl = $('surplusAmt');
  const surplusBarEl = $('surplusBarFill');
  surplusAmtEl.textContent = fmt(surplus);
  surplusAmtEl.classList.toggle('over', surplus < 0);
  surplusBarEl.classList.toggle('over', surplus < 0);
  // Bar: when positive, fill proportional to share of income. When negative,
  // show a thin red sliver so the alert is visible without overwhelming.
  const barPct = income > 0
    ? (surplus >= 0
        ? Math.min(100, (surplus / income) * 100)
        : Math.min(100, (-surplus / income) * 100))
    : 0;
  surplusBarEl.style.width = `${barPct.toFixed(1)}%`;
  $('surplusSub').textContent = surplus >= 0
    ? `${fmt(income)} − ${fmt(totals.budgeted)} − ${fmt(savings)}`
    : `${fmt(-surplus)} over income`;
}

/** Cumulative-spend area chart for view.month. Shows the running total
   to the cutoff day (today if viewing the current month, else end of
   month), plus a delta vs. last month at the same day-of-month. */
function renderHomeHeroChart() {
  const month = view.month;
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const isCurrent = month === thisMonth();
  const cutoffDay = isCurrent ? +today().slice(-2) : daysInMonth;

  // Per-day totals + cumulative
  const dayTotals = new Array(daysInMonth + 1).fill(0);
  const monthEntries = Object.values(state.entries[month] || {}).flat();
  for (const e of monthEntries) {
    const day = +(e.date || '').slice(-2);
    if (day >= 1 && day <= daysInMonth) dayTotals[day] += (+e.amount || 0);
  }
  const cum = new Array(daysInMonth + 1).fill(0);
  for (let i = 1; i <= daysInMonth; i++) cum[i] = cum[i - 1] + dayTotals[i];
  const total = cum[cutoffDay] || 0;

  // Same-window total in previous month for the delta line
  const prevMonth = shiftMonth(month, -1);
  let prevTotal = 0;
  const prevEntries = Object.values(state.entries[prevMonth] || {}).flat();
  for (const e of prevEntries) {
    const day = +(e.date || '').slice(-2);
    if (day >= 1 && day <= cutoffDay) prevTotal += (+e.amount || 0);
  }
  const delta = total - prevTotal;
  const showDelta = prevTotal > 0;
  let deltaHTML = '';
  if (showDelta) {
    const cls   = delta <= 0 ? 'pos' : 'neg';
    const tick  = delta <= 0 ? '✓'   : '↑';
    const label = delta === 0 ? 'Same as last month'
                : delta <  0 ? `${fmt(-delta)} below last month`
                             : `${fmt(delta)} above last month`;
    deltaHTML = `<div class="hc-delta ${cls}"><span class="hc-tick">${tick}</span>${escapeHtml(label)}</div>`;
  }

  // SVG path — viewBox is fixed (W×H), CSS stretches it via preserveAspectRatio="none"
  const W = 320, H = 110;
  const max = Math.max(1, cum[cutoffDay] || 1);
  const xFor = day => daysInMonth > 1 ? ((day - 1) / (daysInMonth - 1)) * W : W / 2;
  // Vertical insets reserve headroom so the end-of-line marker (a circle of
  // r=5) clears the chart's top/bottom edges. The latest point always maps to
  // the scale max, so without TOP_PAD its dot would clip against the top border.
  const TOP_PAD = 14, BOT_PAD = 6;
  const yFor = val => H - (val / max) * (H - TOP_PAD - BOT_PAD) - BOT_PAD;
  const points = [];
  for (let i = 1; i <= cutoffDay; i++) points.push([xFor(i), yFor(cum[i])]);
  if (points.length === 1) points.unshift([0, yFor(0)]);  // need 2 points for a visible stroke

  // Cardinal-spline smoothing — each segment is a cubic Bezier whose control
  // points are derived from the neighbouring data points. Matches the soft
  // curve in modern budgeting apps (Rocket Money etc.) and visually hides
  // the rent-on-day-1 step you'd otherwise see as a vertical matchstick.
  const tension = 0.22;
  let line = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || points[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) * tension;
    const c1y = p1[1] + (p2[1] - p0[1]) * tension;
    const c2x = p2[0] - (p3[0] - p1[0]) * tension;
    const c2y = p2[1] - (p3[1] - p1[1]) * tension;
    line += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const lastX = points[points.length - 1][0];
  const area = `${line} L${lastX.toFixed(1)} ${H} L${points[0][0].toFixed(1)} ${H} Z`;
  const dotX = lastX.toFixed(1);
  const dotY = points[points.length - 1][1].toFixed(1);

  const periodLabel = isCurrent ? 'this month' : monthName(month).toLowerCase();

  $('heroChart').innerHTML = `
    <div class="hc-top">
      <div>
        <div class="hc-label">Current spend ${escapeHtml(periodLabel)}</div>
        <div class="hc-amt num">${escapeHtml(fmt(total))}</div>
      </div>
      ${deltaHTML}
    </div>
    <div class="hc-chart-wrap">
      <svg class="hc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="hcGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--green)" stop-opacity=".4"/>
            <stop offset="100%" stop-color="var(--green)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${area}" fill="url(#hcGrad)"/>
        <path d="${line}" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${dotX}" cy="${dotY}" r="5" fill="var(--green)"/>
        <circle cx="${dotX}" cy="${dotY}" r="2.5" fill="var(--bg)"/>
      </svg>
    </div>
    <div class="hc-footer">
      <span class="hc-foot-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>
        </svg>
      </span>
      <span class="hc-foot-text">View spending</span>
      <span class="hc-foot-chev" aria-hidden="true">›</span>
    </div>
  `;
}

/** One collapsed row per group: title + spent/budget + stacked top-categories bar.
   Tap a row to jump to the Budget tab with that group filtered. */
function categoryGroupSummary(group) {
  const labels = { fixed: 'Non-negotiables', essentials: 'Food & essentials', discretionary: 'Discretionary' };
  const cats = state.categories.filter(c => c.group === group);
  let budgetSum = 0, spentSum = 0;
  for (const c of cats) {
    budgetSum += derive.budget(c);
    spentSum  += derive.spent(c.id);
  }
  const segs = cats
    .map(c => ({ color: c.color || 'grey', spent: derive.spent(c.id), name: c.name }))
    .filter(s => s.spent > 0)
    .sort((a, b) => b.spent - a.spent);
  const segSum = segs.reduce((t, s) => t + s.spent, 0) || 1;
  const segHTML = segs.length
    ? segs.map(s =>
        `<span class="cgr-seg ${escapeHtml(s.color)}" style="width:${(s.spent / segSum * 100).toFixed(1)}%" title="${escapeHtml(s.name)}: ${escapeHtml(fmt(s.spent))}"></span>`
      ).join('')
    : '';
  return `<button class="cat-group-row" data-action="goToGroup" data-group="${group}" aria-label="${escapeHtml(labels[group])}">
    <div class="cgr-head">
      <div class="cgr-name">${escapeHtml(labels[group])}</div>
      <div class="cgr-amts num"><span class="cgr-spent">${escapeHtml(fmt(spentSum))}</span><span class="cgr-budget">/ ${escapeHtml(fmt(budgetSum))}</span></div>
    </div>
    <div class="cgr-bar">${segHTML || '<span class="cgr-seg grey" style="width:0%"></span>'}</div>
  </button>`;
}

function renderBudgetView() {
  // Filter chip active states
  for (const c of document.querySelectorAll('#budgetFilters .chip')) {
    c.classList.toggle('active', c.dataset.filter === view.budgetFilter);
  }
  const cats = view.budgetFilter === 'all'
    ? state.categories
    : state.categories.filter(c => c.group === view.budgetFilter);
  const t = derive.totals();
  $('budgetRight').textContent  = `${fmt(t.spent)} / ${fmt(t.budgeted)}`;
  const monthLbl = $('budgetMonthLabel');
  if (monthLbl) monthLbl.textContent = view.month === thisMonth() ? 'This month' : monthName(view.month);
  renderSpendChart();
  $('budgetFullList').innerHTML = categoryRows(cats);
}

/** 'YYYY-MM' → 'May 26' — short month label for the chart. */
function monthLabelShort(key) {
  const d = new Date(key + '-15');
  return `${d.toLocaleString('en-US', { month: 'short' })} ${String(d.getFullYear()).slice(-2)}`;
}

/** Six pairs of bars ending at MAX(view.month, thisMonth()):
   an outlined "budget" bar + a solid green "spent" bar per month.
   Selected month (view.month) gets the dark pill on the label. */
function renderSpendChart() {
  const anchor = view.month > thisMonth() ? view.month : thisMonth();
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(shiftMonth(anchor, -i));

  const data = months.map(m => {
    const totals = derive.totals(m);
    return {
      key: m,
      label: monthLabelShort(m),
      spent: totals.spent,
      budget: totals.budgeted,
      selected: m === view.month,
    };
  });
  const max = Math.max(1, ...data.flatMap(d => [d.spent, d.budget]));

  $('spendChart').innerHTML = data.map(d => {
    const spentPct  = d.spent  > 0 ? Math.max(6, Math.round((d.spent  / max) * 100)) : 0;
    const budgetPct = d.budget > 0 ? Math.max(6, Math.round((d.budget / max) * 100)) : 0;
    return `<button type="button" class="sc-col ${d.selected ? 'selected' : ''}" data-action="pickMonth" data-month="${d.key}" aria-label="${escapeHtml(d.label)}: ${escapeHtml(fmt(d.spent))} of ${escapeHtml(fmt(d.budget))}">
      <span class="sc-amt">${d.spent > 0 ? escapeHtml(fmt(d.spent)) : ''}</span>
      <span class="sc-bar-wrap">
        <span class="sc-bar sc-bar-budget" style="height:${budgetPct}%"></span>
        <span class="sc-bar sc-bar-spent"  style="height:${spentPct}%"></span>
      </span>
      <span class="sc-lbl">${escapeHtml(d.label)}</span>
    </button>`;
  }).join('');
}

function renderSetupView() {
  $('cfgIncome').value   = state.config.income;
  $('cfgSavings').value  = state.config.savings;
  $('cfgCurrency').value = state.config.currency;
  $('cfgFirstName').value = auth.firstName();
  renderMembers();   // async; fills #membersCard when it returns
}

/** Pull household members via the list_household_members RPC. Fire-and-forget;
   on error we surface a readable message inline. */
async function renderMembers() {
  const card = $('membersCard');
  if (!card) return;
  if (!cloud.householdId) { card.innerHTML = '<div class="empty">Sign in to view members</div>'; return; }
  try {
    const members = await auth.listMembers();
    if (!members.length) { card.innerHTML = '<div class="empty">No members yet</div>'; return; }
    card.innerHTML = members.map(m => {
      const joined = m.joined_at ? new Date(m.joined_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      const youTag = m.is_me ? ' <span style="color:var(--text-dim);font-weight:500">(you)</span>' : '';
      const kickBtn = m.is_me ? '' :
        `<button class="btn-mini danger" data-action="removeMember" data-user="${escapeHtml(m.user_id)}" aria-label="Remove member">✕</button>`;
      return `<div class="member-row">
        <div class="member-info">
          <div class="member-email">${escapeHtml(m.email || '—')}${youTag}</div>
          <div class="member-joined">Joined ${escapeHtml(joined)}</div>
        </div>
        ${kickBtn}
      </div>`;
    }).join('');
  } catch (e) {
    card.innerHTML = `<div class="empty">Couldn't load members: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

/** One row per category, with progress bar and spend stats. */
function categoryRows(cats) {
  if (!cats.length) return '<div class="empty">Nothing here yet</div>';
  return cats.map(cat => {
    const budget = derive.budget(cat);
    const spent  = derive.spent(cat.id);
    const { pct, status } = derive.progress(spent, budget);
    const remaining = budget - spent;
    const txns = derive.entries(cat.id).length;

    const lock = cat.locked ? '🔒' : '';
    const text = cat.note ? escapeHtml(cat.note) + (lock ? ' · ' + lock : '') : lock;
    const note = text ? `<div class="note">${text}</div>` : '';

    const txnTag = txns
      ? ` <span style="color:var(--green);font-weight:700">· ${txns} ${txns === 1 ? 'entry' : 'entries'}</span>`
      : '';
    const cls = status === 'ok' ? '' : status;
    const progress = budget > 0 ? `
        <div class="bar"><div class="fill ${cls}" style="width:${pct}%"></div></div>
        <div class="progress-line">
          <span class="pl-text">${fmt(spent)} of ${fmt(budget)}${txnTag}</span>
          <span class="pl-remaining ${cls}">${remaining >= 0 ? fmt(remaining) + ' left' : fmt(-remaining) + ' over'}</span>
        </div>` : '';

    return `<div class="row" data-action="openEdit" data-id="${cat.id}">
      <div class="icon ${cat.color || 'grey'}">${cat.icon || '•'}</div>
      <div class="meta">
        <div class="name">${escapeHtml(cat.name)}</div>
        ${note}
        ${progress}
      </div>
      <div class="amt-stack">
        <div class="a-spent">${fmt(spent)}</div>
        <div class="a-budget">/ ${fmt(budget)}</div>
      </div>
    </div>`;
  }).join('');
}

function renderFoodView() {
  renderWeekNav();
  renderMealChips();
  renderDinnerWeek();
  renderShopTabs();
  renderShoppingList();
  // Shopping-list budget hint replaces the old standalone "Grocery budget" card.
  const weekly = fmt(Math.round(derive.budgetById('groceries') / 4.33));
  const monthly = fmt(derive.spent('groceries'));
  const monthLbl = view.month === thisMonth() ? 'this month' : monthName(view.month).toLowerCase();
  const line = $('shopBudgetLine');
  if (line) line.textContent = `${weekly} weekly target · ${monthly} ${monthLbl}`;
}

/** Top 5 most-frequent dinner texts across all stored meals. Rendered as
   tap-to-fill chips above the dinner planner. */
function topDinners(n = 5) {
  const counts = new Map();
  for (const key in state.meals) {
    const d = (state.meals[key]?.dinner || '').trim();
    if (!d) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
}

function renderMealChips() {
  const chips = topDinners();
  $('mealChips').innerHTML = chips.map(m =>
    `<button class="meal-chip" data-action="quickAddMeal" data-meal="${escapeHtml(m)}" title="Add to next empty day">${escapeHtml(m)}</button>`
  ).join('');
}

function renderWeekNav() {
  const start = view.week;
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const startLbl = start.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  const endLbl   = start.getMonth() === end.getMonth()
    ? end.toLocaleString('en-US', { day: 'numeric' })
    : end.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  $('weekLabel').textContent = `${startLbl} – ${endLbl}, ${start.getFullYear()}`;

  const offset = Math.round((start - mondayOf(new Date())) / (7 * 86400000));
  const sub = $('weekSub');
  sub.textContent = relativeWeekLabel(offset);
  sub.classList.toggle('is-current', offset === 0);
}
function relativeWeekLabel(n) {
  if (n === 0)  return 'This week';
  if (n === -1) return 'Last week';
  if (n === 1)  return 'Next week';
  return n < 0 ? `${-n} weeks ago` : `In ${n} weeks`;
}

function renderDinnerWeek() {
  const todayKey = today();
  const rows = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(view.week); d.setDate(d.getDate() + i);
    const key  = dayKey(d);
    const when = key === todayKey ? 'is-today' : key < todayKey ? 'is-past' : '';
    const dinner = state.meals?.[key]?.dinner || '';
    return `<div class="dinner-row">
      <div class="dr-day ${when}">
        <div class="dr-dow">${d.toLocaleString('en-US', { weekday: 'short' })}</div>
        <div class="dr-dom">${d.getDate()}</div>
      </div>
      <textarea class="dr-input" data-date="${key}" data-on-input="saveDinner" placeholder="What's for dinner?" rows="1">${escapeHtml(dinner)}</textarea>
    </div>`;
  }).join('');
  $('dinnerWeekCard').innerHTML = rows;
  $('dinnerWeekCard').querySelectorAll('.dr-input').forEach(autoGrow);
}
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function renderShopTabs() {
  for (const btn of document.querySelectorAll('#shopWeekTabs button')) {
    btn.classList.toggle('active', btn.dataset.week === view.shopWeek);
  }
  for (const el of document.querySelectorAll('#shopWeekTabs .wk-d')) {
    const r = derive.shopWeekRange(el.dataset.range);
    el.textContent = `${r.start}–${r.end}`;
  }
}

function renderShoppingList() {
  const list = state.shopping?.[view.month]?.[view.shopWeek] || [];
  const bought = list.filter(it => it.done).length;
  $('shopWeekRight').textContent = list.length ? `${bought}/${list.length} bought` : '';

  if (!list.length) {
    const r = derive.shopWeekRange(view.shopWeek);
    const mon = monthName(view.month).split(' ')[0];
    $('shoppingList').innerHTML =
      `<div class="empty">Nothing for Week ${view.shopWeek} (${mon} ${r.start}–${r.end}) yet — add a product below.</div>`;
    return;
  }
  $('shoppingList').innerHTML = list.map(it => `
    <div class="shop-item ${it.done ? 'done' : ''}" data-action="toggleShop" data-context-action="openShopMenu" data-id="${it.id}">
      <div class="check"></div>
      <div class="text">${escapeHtml(it.item)}</div>
      <div data-action="removeShop" data-id="${it.id}" style="color:var(--text-dim);padding:0 4px;font-size:18px;cursor:pointer">×</div>
    </div>`).join('');
}

function renderEditSheet() {
  const cat = editingCategory(); if (!cat) return;
  const budget = derive.budget(cat);
  const spent  = derive.spent(cat.id);
  const { pct, status } = derive.progress(spent, budget);

  $('editTitle').textContent = cat.name;
  $('editSub').textContent   = cat.group[0].toUpperCase() + cat.group.slice(1);
  $('editRemaining').textContent  = fmt(budget - spent);
  $('editRemaining').className    = 'rc-val num ' + status;
  $('editRemainingSub').textContent = `${fmt(spent)} spent of ${fmt(budget)} budgeted`;

  const ringColor = status === 'over' ? 'var(--red)' : status === 'warn' ? 'var(--amber)' : 'var(--green)';
  const ringDeg   = pct * 3.6;
  $('editRing').style.background = `conic-gradient(${ringColor} ${ringDeg}deg, var(--line-soft) ${ringDeg}deg)`;
  $('editRing').innerHTML        = `<span>${pct}%</span>`;

  renderEditEntries(cat);
  renderEditBudgetScope(cat);
}

function renderEditEntries(cat) {
  // Newest-ADDED first, so a freshly logged amount always lands on top —
  // regardless of the spend date chosen. Entry ids are `Date.now()`-based
  // (base36 time prefix + random), so a descending lexical sort on the id
  // orders by time-added. Matches the Transactions sheet (renderTransactions).
  const entries = derive.entries(cat.id).slice()
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  $('entriesWrap').innerHTML = entries.length
    ? entries.map(e => {
        const date = e.date
          ? new Date(e.date + 'T00:00').toLocaleString('en-US', { month: 'short', day: 'numeric' })
          : '';
        return `<div class="entry-row">
        <div class="e-note">${escapeHtml(e.note || '(no note)')}</div>
        <div class="e-date">${date}</div>
        <div class="e-amt num">${fmt(+e.amount)}</div>
        <div class="e-del" data-action="deleteEntry" data-id="${e.id}">×</div>
      </div>`;
      }).join('')
    : '<div class="entries-empty">No entries yet — tap “Add transaction” above.</div>';
}

function renderEditBudgetScope(cat) {
  const monthLbl = monthName(view.month);
  if (derive.hasOverride(cat.id)) {
    $('editBudgetScope').innerHTML = `· <span style="color:var(--amber)">Custom for ${escapeHtml(monthLbl)}</span>`;
    $('editBudgetHelp').innerHTML  =
      `Default is ${fmt(+cat.budget || 0)}. <a href="#" data-action="resetMonthBudget" style="color:var(--green);text-decoration:underline">Reset to default</a>`;
  } else {
    $('editBudgetScope').innerHTML = `· <span style="color:var(--text-dim)">${escapeHtml(monthLbl)} only</span>`;
    $('editBudgetHelp').textContent = `Edits apply to ${monthLbl} only. Other months keep their own budget.`;
  }
}

function editingCategory() {
  return state.categories.find(c => c.id === view.editId) || null;
}

/* ── 9. Actions — the only callers of commit() ──────────────────────────── */
/* Each function here corresponds to a user-triggered command. They are wired
   up declaratively in the markup via `data-action="<name>"` and dispatched
   through the ACTIONS registry in section 11 — so the functions themselves
   take normal arguments, not DOM events. */

const openModal  = id => $(id).classList.add('open');
/** Close a modal with a slide-down + fade-out animation. The .closing
   class drives the keyframe (see styles.css); after the duration we
   remove both classes so the modal goes back to display:none.
   Keep CLOSE_MS in sync with the CSS animation duration. */
const CLOSE_MS = 300;   // matches the CSS .modal.closing animation duration
const closeModal = id => {
  const el = $(id);
  if (!el || !el.classList.contains('open')) return;
  if (el.classList.contains('closing'))      return;   // already animating out
  el.classList.add('closing');
  setTimeout(() => el.classList.remove('open', 'closing'), CLOSE_MS);
};

/* -- Confirm dialog -------------------------------------------------------
   Promise-based replacement for window.confirm(). Call it with `await` from
   any (async) action; it resolves true on confirm, false on cancel / tap-out
   / Escape. One shared sheet, one pending resolver at a time. */
let _confirmResolve = null;
function confirmModal({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  $('confirmTitle').textContent   = title;
  $('confirmMessage').textContent = message;
  $('confirmCancel').textContent  = cancelLabel;
  const ok = $('confirmOk');
  ok.textContent = confirmLabel;
  ok.classList.toggle('danger', danger);
  ok.classList.toggle('primary', !danger);
  openModal('confirmModal');
  setTimeout(() => ok.focus(), 80);
  // Resolve any prior pending call as cancelled before taking over.
  if (_confirmResolve) _confirmResolve(false);
  return new Promise(resolve => { _confirmResolve = resolve; });
}
function settleConfirm(result) {
  if (!$('confirmModal').classList.contains('open')) return;
  closeModal('confirmModal');
  const resolve = _confirmResolve;
  _confirmResolve = null;
  if (resolve) resolve(result);
}

/* -- Screen navigation ---------------------------------------------------- */

function setView(screen) {
  view.screen = screen;
  // Expose the active screen on <body> so CSS can react to it (e.g. hide
  // the month picker on the food tab, where it'd compete with the week nav).
  document.body.dataset.screen = screen;
  for (const el of document.querySelectorAll('.view'))
    el.classList.toggle('active', el.id === 'view-' + screen);
  for (const el of document.querySelectorAll('nav.bottom .item'))
    el.classList.toggle('active', el.dataset.view === screen);
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* -- Onboarding & re-plan ------------------------------------------------- */

function openOnboard(replan) {
  $('onboardTitle').textContent = replan ? 'Re-plan this month' : 'Plan your month';
  $('onboardSub').textContent = replan
    ? "Adjust income or savings and I'll rebalance discretionary lines while keeping your locked bills."
    : "Tell me what's coming in and how much you want to save. I'll keep your fixed bills locked and rebalance the rest.";
  $('incomeInput').value = state.config.income || '';
  $('saveInput').value   = state.config.savings || '';
  $('cofidisToggle').classList.toggle('on', !!state.config.cofidis);
  openModal('onboard');
}
function closeOnboard()  { closeModal('onboard'); }
function toggleCofidis() { $('cofidisToggle').classList.toggle('on'); }

function applyOnboard() {
  const income  = parseAmount($('incomeInput').value);
  const savings = parseAmount($('saveInput').value);
  const cofidis = $('cofidisToggle').classList.contains('on');
  commit(s => {
    s.config.income   = income;
    s.config.savings  = savings;
    s.config.cofidis  = cofidis;
    rebalanceMonth(s, view.month, income, savings);
  });
  sync.updateConfig({ income, savings, cofidis });
  // Push every override for this month so DB matches the rebalanced state.
  for (const cat of state.categories) {
    if (derive.hasOverride(cat.id)) {
      sync.upsertOverride(view.month, cat.id, state.budgetOverrides[view.month][cat.id]);
    } else {
      sync.deleteOverride(view.month, cat.id);
    }
  }
  closeOnboard();
  snack(`${monthName(view.month)} rebalanced`);
}

/** Per-month override helpers used by saveEdit, resetMonthBudget, rebalance. */
function setOverride(s, catId, month, value) {
  const cat = s.categories.find(c => c.id === catId);
  if (!cat) return;
  const v = +value || 0;
  if (v === (+cat.budget || 0)) {
    // Matches the default — no override needed
    if (s.budgetOverrides[month]) {
      delete s.budgetOverrides[month][catId];
      if (!Object.keys(s.budgetOverrides[month]).length) delete s.budgetOverrides[month];
    }
  } else {
    (s.budgetOverrides[month] ||= {})[catId] = v;
  }
}
function clearOverride(s, catId, month) {
  if (!s.budgetOverrides[month]) return;
  delete s.budgetOverrides[month][catId];
  if (!Object.keys(s.budgetOverrides[month]).length) delete s.budgetOverrides[month];
}

/** Target weights for the rebalance algorithm — sum essentials = 1030, disc = 375. */
const FLEX_DEFAULTS = {
  essentials:    { groceries:600, health:100, fuel:70, drogist:50, kids:60, familyp2p:150 },
  discretionary: { restaurants:80, shopping:60, clothing:30, hair:40, atm:40, travel:60, snacks:25, kinderplezier:40 },
};

/** Auto-balance flex categories for one month to fit (income − savings − locked). */
function rebalanceMonth(s, month, income, savings) {
  const set = (catId, value) => setOverride(s, catId, month, value);
  const sumValues = obj => Object.values(obj).reduce((a, b) => a + b, 0);

  const lockedTotal = s.categories
    .filter(c => c.locked)
    .reduce((total, c) => total + derive.budget(c, month), 0);
  const available = income - savings - lockedTotal;

  const flexCats = s.categories.filter(c => !c.locked);
  const baseEss  = sumValues(FLEX_DEFAULTS.essentials);     // 1030
  const baseDisc = sumValues(FLEX_DEFAULTS.discretionary);  // 375
  const defFor   = c => FLEX_DEFAULTS[c.group]?.[c.id] ?? (+c.budget || 0);

  if (available >= baseEss + baseDisc) {
    // Comfortable — everyone gets their default; surplus split 30/70 groceries/disc.
    for (const c of flexCats) {
      const d = FLEX_DEFAULTS[c.group]?.[c.id];
      if (d != null) set(c.id, d);
    }
    const extra = available - baseEss - baseDisc;
    if (extra > 0) {
      set('groceries', 600 + Math.round(extra * 0.3));
      const disc = flexCats.filter(c => c.group === 'discretionary');
      const discTotal = disc.reduce((t, c) => t + defFor(c), 0);
      for (const c of disc) set(c.id, defFor(c) + Math.round(extra * 0.7 * defFor(c) / discTotal));
    }
  } else if (available >= baseEss) {
    // Essentials safe — scale discretionary down proportionally.
    for (const c of flexCats) {
      if (c.group === 'essentials' && FLEX_DEFAULTS.essentials[c.id] != null)
        set(c.id, FLEX_DEFAULTS.essentials[c.id]);
    }
    const ratio = (available - baseEss) / baseDisc;
    for (const c of flexCats) {
      if (c.group === 'discretionary') set(c.id, Math.max(0, Math.round(defFor(c) * ratio)));
    }
  } else {
    // Tight — protect groceries/fuel/kids/health; pro-rate or zero the rest.
    set('groceries', Math.min(600, Math.round(available * 0.5)));
    set('fuel',      Math.min(70,  Math.round(available * 0.07)));
    set('kids',      Math.min(60,  Math.round(available * 0.05)));
    set('health',    Math.min(100, Math.round(available * 0.08)));
    const used = ['groceries','fuel','kids','health']
      .reduce((t, id) => t + derive.budgetById(id, month), 0);
    const leftover = available - used;
    const weights = { drogist:50, familyp2p:150, restaurants:80, shopping:60, clothing:30, hair:40, atm:40, travel:60, snacks:25, kinderplezier:40 };
    const flex = Object.keys(weights);
    if (leftover > 0) {
      const wsum = sumValues(weights);
      for (const id of flex) set(id, Math.max(0, Math.round(leftover * weights[id] / wsum)));
    } else {
      for (const id of flex) set(id, 0);
    }
  }
}

/* -- Edit sheet (per-category) -------------------------------------------- */

function openEdit(id) {
  const cat = state.categories.find(c => c.id === id);
  if (!cat) return;
  view.editId = id;
  $('editAmount').value = derive.budget(cat);
  $('editNote').value   = cat.note || '';
  $('editLock').classList.toggle('on', !!cat.locked);
  // Make sure the overflow menu is closed when reopening.
  const em = $('editMenu'); if (em) em.hidden = true;
  renderEditSheet();
  openModal('editModal');
}

function closeEdit() {
  closeModal('editModal');
  view.editId = null;
}

function saveEdit() {
  const cat = editingCategory(); if (!cat) return;
  const budget = parseAmount($('editAmount').value);
  const note   = $('editNote').value;
  const locked = $('editLock').classList.contains('on');
  commit(s => {
    setOverride(s, cat.id, view.month, budget);
    const c = s.categories.find(x => x.id === cat.id);
    c.note   = note;
    c.locked = locked;
  });
  const updated = state.categories.find(c => c.id === cat.id);
  sync.upsertCategory(updated);
  if (derive.hasOverride(cat.id)) sync.upsertOverride(view.month, cat.id, budget);
  else                            sync.deleteOverride(view.month, cat.id);
  closeEdit();
  snack('Saved');
}

function resetMonthBudget(e) {
  e?.preventDefault();
  const cat = editingCategory(); if (!cat) return;
  commit(s => clearOverride(s, cat.id, view.month));
  sync.deleteOverride(view.month, cat.id);
  $('editAmount').value = +cat.budget || 0;
  snack('Reset to default');
}

/* -- Add Transaction sheet (dedicated logging surface) -------------------- */

/** Open the Add Transaction sheet for a category. Works whether or not the
   edit sheet is open behind it (the FAB quick-log path skips the edit sheet),
   so the target category is tracked on `view.addTxnCat`, not `view.editId`. */
function openAddTxn(catId) {
  const cat = state.categories.find(c => c.id === catId);
  if (!cat) return;
  view.addTxnCat = catId;

  // Category chip — tinted in the category's colour.
  const color = cat.color || 'grey';
  $('txnCatName').textContent = cat.name;
  const icon = $('txnCatIcon');
  icon.textContent = cat.icon || '•';
  icon.className = 'icon ' + color;
  $('txnCatChip').className = 'txn-cat-chip ' + color;

  // Reset fields. Date defaults to the viewed month (see seedEntryDate).
  $('txnAmount').value = '';
  $('txnNote').value   = '';
  $('txnDate').value   = seedEntryDate();

  openModal('addTxnModal');
  setTimeout(() => $('txnAmount').focus(), 80);
}

function closeAddTxn() { closeModal('addTxnModal'); view.addTxnCat = null; }

/** Commit a new transaction from the Add Transaction sheet, using its own
   inputs and tracked category (view.addTxnCat). cloud's month_key is derived
   from date.slice(0,7); the local bucket is keyed the same way, so an entry
   dated outside view.month still lands correctly. */
function addTransaction() {
  const catId = view.addTxnCat;
  const cat = state.categories.find(c => c.id === catId);
  if (!cat) return;
  const amount = parseAmount($('txnAmount').value);
  if (!amount || amount <= 0) { snack('Enter an amount'); return; }
  const note = $('txnNote').value.trim() || cat.name;
  const date = $('txnDate').value || seedEntryDate();
  const monthKey = date.slice(0, 7);
  const entry = { id: newId(), amount, note, date };
  commit(s => {
    const list = ((s.entries[monthKey] ||= {})[cat.id] ||= []);
    list.push(entry);
  });
  sync.upsertEntry(cat.id, entry);
  // commit() already re-rendered everything (incl. the edit sheet behind this
  // one, if open) — just close and confirm.
  closeAddTxn();
  snack(`${fmt(amount)} logged${monthKey !== view.month ? ' in ' + monthName(monthKey) : ''}`);
}

function deleteEntry(entryId) {
  const cat = editingCategory(); if (!cat) return;
  commit(s => {
    const list = s.entries[view.month]?.[cat.id]; if (!list) return;
    s.entries[view.month][cat.id] = list.filter(e => e.id !== entryId);
    if (!s.entries[view.month][cat.id].length) delete s.entries[view.month][cat.id];
  });
  sync.deleteEntry(entryId);
  snack('Entry removed');
}

async function deleteCategory() {
  const cat = editingCategory(); if (!cat) return;
  const count = derive.entries(cat.id).length;
  const ok = await confirmModal({
    title: 'Delete category?',
    message: `“${cat.name}” and all ${count} ${count === 1 ? 'entry' : 'entries'} this month will be removed.`,
    confirmLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  commit(s => {
    s.categories = s.categories.filter(c => c.id !== cat.id);
    for (const m in s.entries) delete s.entries[m][cat.id];
  });
  sync.deleteCategory(cat.id);   // CASCADE in DB cleans entries + overrides
  closeEdit();
  snack('Removed');
}

/* -- Quick log (FAB) ------------------------------------------------------ */

function openQuickLog() {
  // Frequently logged first, then everything non-fixed; dedup by id.
  const priority = ['groceries','restaurants','shopping','fuel','drogist','health','clothing','familyp2p','kids','hair','atm','travel'];
  const seen = new Set();
  const ordered = [
    ...priority.map(id => state.categories.find(c => c.id === id)).filter(Boolean),
    ...state.categories.filter(c => c.group !== 'fixed'),
  ].filter(c => !seen.has(c.id) && seen.add(c.id));
  $('pickerGrid').innerHTML = ordered.map(c => `
    <div class="picker-cell" data-action="pickCategory" data-id="${c.id}">
      <div class="pc-icon">${c.icon || '•'}</div>
      <div class="pc-name">${escapeHtml(c.name)}</div>
    </div>`).join('');
  openModal('quickLog');
}
function closeQuickLog() { closeModal('quickLog'); }
// Quick-log goes straight to the Add Transaction sheet — logging is the goal,
// no need to detour through the category's edit sheet.
function pickCategory(id) { closeQuickLog(); openAddTxn(id); }

/* -- Transactions sheet (header sheets button) ---------------------------- */

/** Short "Mon D" label from a 'YYYY-MM-DD' string, parsed as a local date
   (avoids the UTC off-by-one that `new Date('YYYY-MM-DD')` causes). */
function txnDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function openTransactions() { renderTransactions(); openModal('txnsModal'); }
function closeTransactions() { closeModal('txnsModal'); }

/** Flat list of every entry logged in the selected month, newest-added first.
   Entry ids are `Date.now().toString(36)` + random, so a descending lexical
   sort on the id orders by time-added without needing a stored timestamp. */
function renderTransactions() {
  const month = view.month;
  $('txnsSub').textContent = `Entries logged in ${monthName(month)}.`;

  const byCat = state.entries?.[month] || {};
  const rows = [];
  for (const catId in byCat) {
    const cat = state.categories.find(c => c.id === catId);
    for (const e of byCat[catId]) rows.push({ e, cat, catId });
  }
  rows.sort((a, b) => (a.e.id < b.e.id ? 1 : a.e.id > b.e.id ? -1 : 0));

  const list = $('txnsList');
  if (!rows.length) {
    list.innerHTML = '<div class="empty">No transactions logged this month</div>';
    return;
  }
  list.innerHTML = rows.map(({ e, cat, catId }) => {
    const catName = cat?.name || 'Uncategorised';
    const note    = (e.note && e.note.trim()) ? e.note : catName;
    return `<div class="txn-row" data-action="openTxnCategory" data-id="${escapeHtml(catId)}">
      <div class="icon ${cat?.color || 'grey'}">${cat?.icon || '•'}</div>
      <div class="txn-meta">
        <div class="txn-note">${escapeHtml(note)}</div>
        <div class="txn-sub">${escapeHtml(catName)} · ${escapeHtml(txnDate(e.date))}</div>
      </div>
      <div class="txn-amt">${fmt(+e.amount)}</div>
    </div>`;
  }).join('');
}

/** Tap a transaction → jump into its category's edit sheet. */
function openTxnCategory(id) { closeTransactions(); openEdit(id); }

/* -- Profile (first name) ------------------------------------------------- */

/** Save the user's first name to auth metadata, then refresh the greeting.
   Per-user, so it's independent of the shared household config. */
async function saveProfile() {
  if (!cloud.session) return;
  const name = $('cfgFirstName').value.trim();
  if (name === auth.firstName()) return;   // no-op on unchanged blur
  try {
    await auth.updateProfile({ firstName: name });
    renderHeader();
    snack('Name updated');
  } catch (e) {
    snack('Couldn’t update name: ' + (e.message || String(e)));
  }
}

/* -- Add a new category --------------------------------------------------- */

function openAdd() {
  $('addName').value   = '';
  $('addAmount').value = '';
  $('addGroup').value  = 'discretionary';
  $('addLock').classList.remove('on');
  openModal('addModal');
}
function closeAdd() { closeModal('addModal'); }
function saveAdd() {
  const name = $('addName').value.trim();
  if (!name) { snack('Name required'); return; }
  const cat = {
    id:     name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_' + Date.now().toString(36),
    name,
    group:  $('addGroup').value,
    note:   '',
    budget: parseAmount($('addAmount').value),
    locked: $('addLock').classList.contains('on'),
    icon:   '•',
    color:  'grey',
  };
  commit(s => s.categories.push(cat));
  sync.upsertCategory(cat, state.categories.length - 1);
  closeAdd();
  snack('Added');
}

/* -- Settings ------------------------------------------------------------- */

/** Persist the Plan inputs. `quiet=true` suppresses the snack — used by the
   auto-save-on-blur flow so every field change doesn't spawn a toast. */
function saveConfig(quiet = false) {
  const income   = parseAmount($('cfgIncome').value);
  const savings  = parseAmount($('cfgSavings').value);
  const currency = $('cfgCurrency').value.trim() || '€';
  commit(s => { s.config.income = income; s.config.savings = savings; s.config.currency = currency; });
  sync.updateConfig({ income, savings, currency });
  if (!quiet) snack('Settings saved');
}

async function copyInvite() {
  const code = cloud.inviteCode;
  if (!code) { snack('No invite code yet'); return; }
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Family Budget invite', text: `Join our household budget — invite code: ${code}` });
      return;
    }
    await navigator.clipboard.writeText(code);
    snack('Code copied');
  } catch {
    snack('Copy failed — select the code manually');
  }
}

async function rotateInvite() {
  const ok = await confirmModal({
    title: 'Generate a new invite code?',
    message: 'The old code stops working immediately. Existing members keep their access.',
    confirmLabel: 'Generate',
  });
  if (!ok) return;
  try {
    const newCode = await auth.rotateInviteCode();
    $('acctInvite').textContent = newCode;
    snack('Invite code rotated');
  } catch (e) {
    snack('Rotate failed: ' + (e.message || e));
  }
}

async function removeMember(userId) {
  const ok = await confirmModal({
    title: 'Remove this member?',
    message: 'They lose access to the household immediately.',
    confirmLabel: 'Remove', danger: true,
  });
  if (!ok) return;
  try {
    await auth.removeMember(userId);
    snack('Member removed');
    renderMembers();
  } catch (e) {
    snack('Remove failed: ' + (e.message || e));
  }
}

/* -- Month navigation (the top picker) ----------------------------------- */

function stepMonth(delta) {
  const next = shiftMonth(view.month, delta);
  const { min, max } = derive.monthBounds();
  if (next < min || next > max) return;
  view.month = next;
  render();
  snack(monthName(view.month));
}
function pickMonth(month) {
  view.month = month;
  closeMonthPicker();
  render();
  snack(monthName(month));
}
function closeMonthPicker() { closeModal('monthPicker'); }

function openMonthPicker() {
  // Include the rolling window plus any month with logged spend (even outside the window).
  const months = new Set();
  for (let i = -MONTH_RANGE.back; i <= MONTH_RANGE.ahead; i++) months.add(shiftMonth(thisMonth(), i));
  for (const m in state.entries) if (Object.keys(state.entries[m] || {}).length) months.add(m);
  const now = thisMonth();
  $('monthList').innerHTML = [...months].sort().reverse().map(m => {
    const t = derive.totals(m);
    const meta = t.spent > 0 ? `${fmt(t.spent)} spent` : (m > now ? 'Upcoming' : 'No activity');
    return `<button type="button" class="month-cell ${m === view.month ? 'active' : ''} ${m === now ? 'is-today' : ''}" data-action="pickMonth" data-month="${m}">
      <span class="mc-name">${escapeHtml(monthName(m))}</span>
      <span class="mc-meta">${escapeHtml(meta)}</span>
    </button>`;
  }).join('');
  openModal('monthPicker');
  // Centre the active month after the sheet animates in
  setTimeout(() => $('monthList').querySelector('.month-cell.active')?.scrollIntoView({ block: 'center' }), 20);
}

/* -- Dinner planner ------------------------------------------------------- */

function stepWeek(delta) {
  const d = new Date(view.week); d.setDate(d.getDate() + delta * 7);
  view.week = d;
  renderFoodView();
}
function goToCurrentWeek() {
  view.week = mondayOf(new Date());
  renderFoodView();
  snack('This week');
}

/** Copy each day's dinner from the previous week into the current week's
   same day-of-week. Skips days that already have a dinner set. */
function copyLastWeek() {
  let count = 0;
  const dayKeys = [];
  for (let i = 0; i < 7; i++) {
    const cur = new Date(view.week);  cur.setDate(cur.getDate() + i);
    const prev = new Date(view.week); prev.setDate(prev.getDate() - 7 + i);
    dayKeys.push({ curKey: dayKey(cur), prevKey: dayKey(prev) });
  }
  commit(s => {
    for (const { curKey, prevKey } of dayKeys) {
      const prevDinner = (s.meals[prevKey]?.dinner || '').trim();
      const curDinner  = (s.meals[curKey]?.dinner || '').trim();
      if (prevDinner && !curDinner) {
        (s.meals[curKey] = s.meals[curKey] || {}).dinner = prevDinner;
        count++;
      }
    }
  });
  // Push the affected days. state is fresh after commit().
  for (const { curKey } of dayKeys) {
    if (state.meals[curKey]) sync.upsertMeal(curKey, state.meals[curKey]);
  }
  snack(count > 0 ? `Copied ${count} meal${count === 1 ? '' : 's'}` : 'Last week was empty');
}

/** Tap a meal chip → fill the first empty day in the current week. */
function quickAddMeal(meal) {
  if (!meal) return;
  let filledKey = null;
  commit(s => {
    for (let i = 0; i < 7; i++) {
      const d = new Date(view.week); d.setDate(d.getDate() + i);
      const key = dayKey(d);
      if (!(s.meals[key]?.dinner || '').trim()) {
        (s.meals[key] = s.meals[key] || {}).dinner = meal;
        filledKey = key;
        return;
      }
    }
  });
  if (filledKey) {
    sync.upsertMeal(filledKey, state.meals[filledKey]);
    snack(`Added to ${new Date(filledKey + 'T00:00').toLocaleString('en-US', { weekday: 'short' })}`);
  } else {
    snack('No empty days this week');
  }
}

/** Toggle the edit-modal overflow menu (currently houses Delete). */
function toggleEditMenu() {
  const m = $('editMenu');
  if (m) m.hidden = !m.hidden;
}
/** Save dinner text WITHOUT re-rendering — the textarea is the live view of the data. */
function saveDinner(textarea) {
  autoGrow(textarea);
  const key = textarea.dataset.date;
  const value = textarea.value;
  let emptied = false;
  commit(s => {
    const day = s.meals[key] || {};
    day.dinner = value;
    const empty = !value.trim() && !day.breakfast && !day.lunch && !day.notes;
    if (empty) { delete s.meals[key]; emptied = true; }
    else        s.meals[key] = day;
  }, { render: false });
  if (emptied) sync.deleteMeal(key);
  else         sync.upsertMeal(key, state.meals[key]);
}

/* -- Shopping list -------------------------------------------------------- */

function setShopWeek(week) {
  view.shopWeek = String(week);
  renderShopTabs();
  renderShoppingList();
}

/** Get-or-create the weekly bucket inside a mutator. */
function shopBucketIn(s, week, month = view.month) {
  const wk = (s.shopping[month] ||= { '1':[], '2':[], '3':[], '4':[] });
  return (wk[week] ||= []);
}

function addShopItem() {
  const name = $('shopItem').value.trim();
  if (!name) return;
  const item = { id: newId(), item: name, done: false };
  commit(s => shopBucketIn(s, view.shopWeek).push(item));
  sync.upsertShopItem(view.month, view.shopWeek, item);
  $('shopItem').value = '';
  $('shopItem').focus();
}
function toggleShop(id) {
  let toggled = null;
  commit(s => {
    const it = shopBucketIn(s, view.shopWeek).find(i => i.id === id);
    if (it) { it.done = !it.done; toggled = it; }
  });
  if (toggled) sync.upsertShopItem(view.month, view.shopWeek, toggled);
}
function removeShop(id) {
  commit(s => {
    s.shopping[view.month][view.shopWeek] = shopBucketIn(s, view.shopWeek).filter(i => i.id !== id);
  });
  sync.deleteShopItem(id);
}

/* -- Shopping context menu (right-click / long-press) -------------------- */

function openShopMenu(e, itemId) {
  e.preventDefault();
  view.ctxId = itemId;
  const others = ['1','2','3','4'].filter(w => w !== view.shopWeek);
  const row = (action, w) => {
    const r = derive.shopWeekRange(w);
    const icon = action === 'copy' ? '⧉' : '→';
    return `<button type="button" class="ctx-item" data-action="moveShopItem" data-mode="${action}" data-week="${w}">${icon}&nbsp; Week ${w} <span style="color:var(--text-dim);font-weight:500">· ${r.start}–${r.end}</span></button>`;
  };
  const menu = $('ctxMenu');
  menu.innerHTML =
    `<div class="ctx-head">Duplicate to</div>${others.map(w => row('copy', w)).join('')}` +
    `<div class="ctx-sep"></div>` +
    `<div class="ctx-head">Move to</div>${others.map(w => row('move', w)).join('')}`;
  menu.classList.add('open');
  // Clamp the menu inside the viewport
  const x = Math.max(8, Math.min(e.clientX, innerWidth  - menu.offsetWidth  - 8));
  const y = Math.max(8, Math.min(e.clientY, innerHeight - menu.offsetHeight - 8));
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}
function closeShopMenu() {
  $('ctxMenu').classList.remove('open');
  view.ctxId = null;
}
function moveShopItem(action, week) {
  const itemId = view.ctxId;
  let copyItem = null;
  let movedItem = null;
  commit(s => {
    const from = shopBucketIn(s, view.shopWeek);
    const item = from.find(i => i.id === itemId);
    if (!item) return;
    if (action === 'copy') {
      copyItem = { id: newId(), item: item.item, done: false };
      shopBucketIn(s, week).push(copyItem);
    } else {
      movedItem = { id: item.id, item: item.item, done: item.done };
      shopBucketIn(s, week).push(movedItem);
      s.shopping[view.month][view.shopWeek] = from.filter(i => i.id !== itemId);
    }
  });
  if (copyItem)  sync.upsertShopItem(view.month, week, copyItem);
  if (movedItem) sync.upsertShopItem(view.month, week, movedItem);  // PK is item id; new month/week overwrites
  closeShopMenu();
  snack(`${action === 'copy' ? 'Duplicated' : 'Moved'} to Week ${week}`);
}

/* -- Manual refresh from the cloud --------------------------------------- */

/** Pull the household's data fresh from Supabase and re-render.
   Triggered by tapping the refresh icon or by pull-to-refresh on touch. */
async function refresh() {
  if (cloud.pending > 0) return;       // already in flight
  if (!cloud.householdId) return;      // not signed in / no household yet
  const ptr = $('ptr');
  const btn = $('refreshBtn');
  ptr.classList.add('refreshing');
  ptr.classList.remove('ready', 'visible');
  btn?.classList.add('refreshing');
  try {
    await hydrate();
  } finally {
    ptr.classList.remove('refreshing');
    ptr.style.transform = '';
    btn?.classList.remove('refreshing');
  }
}

/* -- Resets -------------------------------------------------------------- */

async function resetPlan() {
  const ok = await confirmModal({
    title: 'Reset all budgets to defaults?',
    message: 'Every budget amount goes back to the seeded defaults. Meal plans and shopping list are kept.',
    confirmLabel: 'Reset plan', danger: true,
  });
  if (!ok) return;
  const defaults = structuredClone(DEFAULTS.categories);
  const defaultIds = new Set(defaults.map(c => c.id));
  // Delete categories the user added that aren't in DEFAULTS.
  for (const cat of state.categories) {
    if (!defaultIds.has(cat.id)) sync.deleteCategory(cat.id);
  }
  commit(s => { s.categories = defaults; });
  // Re-upsert every default category to restore canonical values.
  defaults.forEach((cat, i) => sync.upsertCategory(cat, i));
  snack('Plan reset');
}
async function hardReset() {
  const ok = await confirmModal({
    title: 'Wipe local data & sign out?',
    message: 'This signs you out and clears local data. Your cloud household stays on the server — ask the admin to delete it if you want it gone.',
    confirmLabel: 'Wipe & sign out', danger: true,
  });
  if (!ok) return;
  await auth.signOut();
  state = blankState();
  localStorage.removeItem(STORE_KEY);
  showAuthModal('signin');
  snack('Signed out');
}

/* ── 10. Snackbar ──────────────────────────────────────────────────────── */
/* A toast lives in the DOM only while it is visible; the newest message
   replaces any in-flight one. */
let snackHideTimer = null;
let snackRemoveTimer = null;
function snack(message) {
  clearTimeout(snackHideTimer);
  clearTimeout(snackRemoveTimer);
  for (const el of document.querySelectorAll('.snack')) el.remove();

  const el = document.createElement('div');
  el.className = 'snack';
  el.textContent = message;
  document.body.appendChild(el);
  // Force a reflow so the slide-in transition plays from the off-screen state
  void el.offsetHeight;
  el.classList.add('show');

  snackHideTimer = setTimeout(() => {
    el.classList.remove('show');
    snackRemoveTimer = setTimeout(() => el.remove(), SNACK.transitionMs);
  }, SNACK.visibleMs);
}

/* ── 11. Global wiring & init ──────────────────────────────────────────── */

/* The app uses a single delegated listener per event type rather than inline
   handlers in markup. Every interactive element declares its intent via
   `data-action` / `data-context-action` / `data-on-input`; the delegate()
   helper looks up the named action below and invokes it.

   Each action handler receives (event, dataset, element) and pulls whatever
   arguments it needs out of the dataset — keeping the wiring declarative and
   the action functions themselves unchanged. */

const ACTIONS = {
  // Screen / month nav
  setView:           (_, d) => setView(d.view),
  openMonthPicker, closeMonthPicker,
  pickMonth:         (_, d) => pickMonth(d.month),
  stepMonth:         (_, d) => stepMonth(+d.delta),

  // Onboarding
  openOnboard:       (_, d) => openOnboard(d.replan === 'true'),
  closeOnboard, applyOnboard, toggleCofidis,

  // Edit category sheet
  openEdit:          (_, d) => openEdit(d.id),
  closeEdit, saveEdit, deleteCategory,
  deleteEntry:       (_, d) => deleteEntry(d.id),
  resetMonthBudget:   e     => resetMonthBudget(e),

  // Add Transaction sheet
  openAddTxn:        (_, d) => openAddTxn(d.id),
  addTxnForCurrent:  ()     => { if (view.editId) openAddTxn(view.editId); },
  closeAddTxn, addTransaction,

  // Lock toggles shared by edit + add modals
  toggleLockClass:   (_, __, el) => el.classList.toggle('on'),

  // Add category
  openAdd, closeAdd, saveAdd,

  // Settings
  saveConfig, signOutNow, hardReset,

  // Auth UI
  setAuthTab:        (_, d) => setAuthTab(d.tab),
  submitAuth,

  // Food / dinner week nav
  stepWeek:          (_, d) => stepWeek(+d.delta),
  goToCurrentWeek,
  setShopWeek:       (_, d) => setShopWeek(d.week),

  // Shopping list
  addShopItem,
  toggleShop:        (_, d) => toggleShop(d.id),
  removeShop:        (_, d) => removeShop(d.id),
  moveShopItem:      (_, d) => moveShopItem(d.mode, d.week),

  // Quick log (FAB)
  openQuickLog, closeQuickLog,
  pickCategory:      (_, d) => pickCategory(d.id),

  // Transactions sheet (header sheets button)
  openTransactions, closeTransactions,
  openTxnCategory:   (_, d) => openTxnCategory(d.id),

  // Budget view reset
  resetPlan,

  // Manual cloud refresh (refresh icon, or pull-to-refresh)
  refresh,

  // Budget filter chips + jump-from-home tiles
  setBudgetFilter:  (_, d) => { view.budgetFilter = d.filter; render(); },
  goToGroup:        (_, d) => { view.budgetFilter = d.group;  setView('budget'); },

  // Food: copy last week's dinners + tap a chip to fill the next empty day
  copyLastWeek,
  quickAddMeal:     (_, d) => quickAddMeal(d.meal),

  // Settings: auto-save handled via data-on-change; invite + member actions here
  copyInvite,
  rotateInvite,
  removeMember:     (_, d) => removeMember(d.user),

  // Edit modal overflow menu
  toggleEditMenu,

  // Tap the sync pill — show last error if any
  showSyncStatus:   () => snack(cloud.lastError ? `Sync error: ${cloud.lastError}` : 'Up to date'),

  // Confirm dialog
  confirmOk:        () => settleConfirm(true),
  confirmCancel:    () => settleConfirm(false),
};

/** Inputs with data-on-change="autoSaveConfig" trigger this on blur. */
const CHANGE_ACTIONS = {
  autoSaveConfig: () => saveConfig(true),
  autoSaveProfile: () => saveProfile(),
};

const CONTEXT_ACTIONS = {
  openShopMenu: (e, d) => openShopMenu(e, d.id),
};

const INPUT_ACTIONS = {
  saveDinner: (_, __, el) => saveDinner(el),
};

function delegate(eventName, attr, registry) {
  document.addEventListener(eventName, e => {
    const el = e.target.closest?.(`[${attr}]`);
    if (!el) return;
    const fn = registry[el.getAttribute(attr)];
    if (fn) fn(e, el.dataset, el);
  });
}

delegate('click',       'data-action',         ACTIONS);
delegate('contextmenu', 'data-context-action', CONTEXT_ACTIONS);
delegate('input',       'data-on-input',       INPUT_ACTIONS);
delegate('change',      'data-on-change',      CHANGE_ACTIONS);

// Close the edit-modal overflow menu on any outside click.
document.addEventListener('click', e => {
  const menu = $('editMenu');
  if (!menu || menu.hidden) return;
  if (e.target.closest('#editMenu') || e.target.closest('.overflow-btn')) return;
  menu.hidden = true;
});

// Enter submits the shopping and transaction inputs.
document.addEventListener('keydown', e => {
  // Escape cancels the confirm dialog (Enter is handled by the focused button).
  if (e.key === 'Escape' && $('confirmModal').classList.contains('open')) {
    settleConfirm(false);
    return;
  }
  if (e.key !== 'Enter') return;
  const id = document.activeElement?.id;
  if (id === 'shopItem')                              addShopItem();
  if (id === 'txnNote' || id === 'txnAmount')         addTransaction();
});

// Long-press on a shopping item opens its context menu on touch devices.
let longPressTimer = null;
document.addEventListener('touchstart', e => {
  const row = e.target.closest?.('[data-context-action="openShopMenu"]');
  if (!row) return;
  const id = row.dataset.id;
  const t = e.touches[0];
  longPressTimer = setTimeout(
    () => openShopMenu({ preventDefault() {}, clientX: t.clientX, clientY: t.clientY }, id),
    480);
}, { passive: true });
for (const ev of ['touchend','touchmove','touchcancel'])
  document.addEventListener(ev, () => clearTimeout(longPressTimer), { passive: true });

// Dismiss the context menu on any outside click or scroll.
document.addEventListener('click', e => {
  if ($('ctxMenu').classList.contains('open') && !e.target.closest('#ctxMenu')) closeShopMenu();
});
window.addEventListener('scroll', () => { if (view.ctxId) closeShopMenu(); }, true);

/* ── Tap outside the sheet to dismiss the modal ─────────────────────────
   Each entry in MODAL_CLOSERS maps a modal id to its close action.
   authModal is intentionally absent — it's the sign-in gate, you
   sign in to dismiss it. The click only fires when the target IS the
   backdrop (i.e. the .modal element itself); taps inside the sheet
   bubble through the sheet first and never reach this listener as
   target === the modal. */
const MODAL_CLOSERS = {
  editModal:    closeEdit,
  addTxnModal:  closeAddTxn,
  addModal:     closeAdd,
  onboard:      closeOnboard,
  quickLog:     closeQuickLog,
  monthPicker:  closeMonthPicker,
  txnsModal:    closeTransactions,
  confirmModal: () => settleConfirm(false),   // tap backdrop = cancel
};
document.addEventListener('click', e => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (!t.classList.contains('modal') || !t.classList.contains('open')) return;
  const closer = MODAL_CLOSERS[t.id];
  if (closer) closer();
});

/* ── Pull-to-refresh ─────────────────────────────────────────────────────
   Only kicks in at the very top of the page, outside any modal, while
   signed in and not already syncing. Past the threshold the indicator
   turns green; release to fire refresh(). Below threshold it snaps back. */
const PTR_THRESHOLD = 70;
let ptrStartY = null;
let ptrDistance = 0;
function ptrEligible() {
  return window.scrollY <= 0
      && !document.querySelector('.modal.open')
      && cloud.householdId
      && cloud.pending === 0;
}
document.addEventListener('touchstart', e => {
  if (!ptrEligible()) return;
  ptrStartY   = e.touches[0].clientY;
  ptrDistance = 0;
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (ptrStartY == null) return;
  const deltaY = e.touches[0].clientY - ptrStartY;
  if (deltaY <= 0) return;
  ptrDistance = Math.min(deltaY * 0.5, 100);  // 0.5 = rubber-band damping
  const ptr = $('ptr');
  ptr.classList.add('visible');
  ptr.style.transform = `translate(-50%, ${ptrDistance - 36}px)`;
  ptr.classList.toggle('ready', ptrDistance >= PTR_THRESHOLD);
}, { passive: true });
document.addEventListener('touchend', () => {
  if (ptrStartY == null) return;
  const triggered = ptrDistance >= PTR_THRESHOLD;
  ptrStartY = null;
  ptrDistance = 0;
  const ptr = $('ptr');
  if (triggered) {
    refresh();   // refresh() handles its own visual state
  } else {
    ptr.classList.remove('visible', 'ready');
    ptr.style.transform = '';
  }
}, { passive: true });

/* ── 12. Auth UI handlers: see auth-ui.js ──────────────────────────────── */

/* ── 13. Boot ──────────────────────────────────────────────────────────── */

(async function boot() {
  // Reflect the initial active view on <body> (the HTML defaults to home).
  document.body.dataset.screen = 'home';

  // Launch splash: covers the page until auth state is resolved. We measure
  // start time so we can enforce a minimum visible duration on cached/instant
  // session resolves — otherwise the splash would flash by too quickly to
  // register as a deliberate opening screen.
  const splash = document.getElementById('splash');
  const splashStart = performance.now();
  const MIN_SPLASH_MS = 550;        // floor so the splash always feels intentional
  const FADE_MS = 450;              // must match `.splash` transition in styles.css

  function hideSplash() {
    if (!splash) return;
    const wait = Math.max(0, MIN_SPLASH_MS - (performance.now() - splashStart));
    setTimeout(() => {
      splash.classList.add('hidden');
      // Remove from the DOM once the fade completes so it can't intercept
      // taps or get re-shown by stale references.
      setTimeout(() => splash.remove(), FADE_MS + 50);
    }, wait);
  }

  try {
    runMigrations();
    render();   // render blank UI behind the auth modal so the page isn't empty
    await auth.getSession();
    if (cloud.session) {
      // Authenticated: hydrate and let the splash fade straight to the app.
      await onAuthed();
    } else {
      // No session: open the auth modal *under* the splash so it's already
      // in place when the splash fades, instead of popping in afterwards.
      showAuthModal('signin');
    }
  } finally {
    // Always release the splash — even if boot threw, the user should see
    // something interactive (modal or partially-rendered app) rather than a
    // permanently stuck opening screen.
    hideSplash();
  }
})();
