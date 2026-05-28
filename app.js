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
  screen:   'home',
  month:    thisMonth(),
  week:     mondayOf(new Date()),
  shopWeek: '1',
  editId:   null,
  ctxId:    null,
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
  renderHeaderPicker();
  renderHome();
  renderBudgetView();
  renderSetupView();
  renderFoodView();
  if (view.editId) renderEditSheet();
}

function renderHeaderPicker() {
  $('monthLabel').textContent = monthName(view.month);
  const { min, max } = derive.monthBounds();
  $('monthPrev').disabled = view.month <= min;
  $('monthNext').disabled = view.month >= max;
}

function renderHome() {
  const t = derive.totals();
  const income    = +state.config.income  || 0;
  const savings   = +state.config.savings || 0;
  const remaining = t.budgeted - t.spent;

  $('heroAmount').textContent = fmt(remaining);
  const pill = $('heroPill');
  pill.classList.toggle('bad', remaining < 0);
  pill.textContent = remaining >= 0 ? `${fmt(t.spent)} spent` : `${fmt(-remaining)} over`;
  $('heroNote').textContent = remaining >= 0 ? `of ${fmt(t.budgeted)} budgeted` : 'budget exceeded';

  $('statIncome').textContent = fmt(income);
  $('statSpent').textContent  = fmt(t.spent);
  $('statSaved').textContent  = fmt(savings);
  const delta = $('statSpentDelta');
  delta.textContent = remaining >= 0 ? `${fmt(remaining)} left` : `${fmt(-remaining)} over`;
  delta.className   = 'delta ' + (remaining >= 0 ? 'pos' : 'neg');

  $('fixedRight').textContent = fmt(t.fixed);
  $('essRight').textContent   = fmt(t.ess);
  $('discRight').textContent  = fmt(t.disc);
  $('fixedList').innerHTML = categoryRows(state.categories.filter(c => c.group === 'fixed'));
  $('essList').innerHTML   = categoryRows(state.categories.filter(c => c.group === 'essentials'));
  $('discList').innerHTML  = categoryRows(state.categories.filter(c => c.group === 'discretionary'));

  $('sumIn').textContent    = fmt(income);
  $('sumOut').textContent   = fmt(t.budgeted);
  $('sumSave').textContent  = fmt(savings);
  $('sumSlack').textContent = fmt(income - t.budgeted - savings);
}

function renderBudgetView() {
  const t = derive.totals();
  $('budgetRight').textContent  = `${fmt(t.spent)} / ${fmt(t.budgeted)}`;
  $('budgetFullList').innerHTML = categoryRows(state.categories);
}

function renderSetupView() {
  $('cfgIncome').value    = state.config.income;
  $('cfgSavings').value   = state.config.savings;
  $('cfgCurrency').value  = state.config.currency;
  $('setupAll').innerHTML = categoryRows(state.categories);
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
  renderDinnerWeek();
  renderShopTabs();
  renderShoppingList();
  $('monthGroceries').textContent = fmt(derive.spent('groceries'));
  $('weeklyTarget').textContent   = fmt(Math.round(derive.budgetById('groceries') / 4.33));
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
  const entries = derive.entries(cat.id).slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
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
    : '<div class="entries-empty">No entries yet — add the first transaction above.</div>';
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
const closeModal = id => $(id).classList.remove('open');

/* -- Screen navigation ---------------------------------------------------- */

function setView(screen) {
  view.screen = screen;
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
  $('entryNote').value   = '';
  $('entryAmount').value = '';
  renderEditSheet();
  openModal('editModal');
  setTimeout(() => $('entryAmount').focus(), 80);
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

function addEntry() {
  const cat = editingCategory(); if (!cat) return;
  const amount = parseAmount($('entryAmount').value);
  if (!amount || amount <= 0) { snack('Enter an amount'); return; }
  const note = $('entryNote').value.trim() || cat.name;
  // Date must fall inside view.month — otherwise cloud's month_key (derived
  // from the date) ends up in the wrong bucket and on reload hydrate()
  // collapses the entry into the current month. Use today when we're
  // already viewing the current month, the 15th of the viewed month
  // otherwise (always a valid day, sits comfortably mid-month).
  const date = view.month === thisMonth() ? today() : `${view.month}-15`;
  const entry = { id: newId(), amount, note, date };
  commit(s => {
    const list = ((s.entries[view.month] ||= {})[cat.id] ||= []);
    list.push(entry);
  });
  sync.upsertEntry(cat.id, entry);
  $('entryNote').value   = '';
  $('entryAmount').value = '';
  snack(`${fmt(amount)} logged`);
  setTimeout(() => $('entryAmount').focus(), 50);
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

function deleteCategory() {
  const cat = editingCategory(); if (!cat) return;
  const count = derive.entries(cat.id).length;
  if (!confirm(`Delete "${cat.name}"? All ${count} entries this month will go with it.`)) return;
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
function pickCategory(id) { closeQuickLog(); openEdit(id); }

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

function saveConfig() {
  const income   = parseAmount($('cfgIncome').value);
  const savings  = parseAmount($('cfgSavings').value);
  const currency = $('cfgCurrency').value.trim() || '€';
  commit(s => { s.config.income = income; s.config.savings = savings; s.config.currency = currency; });
  sync.updateConfig({ income, savings, currency });
  snack('Settings saved');
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

function resetPlan() {
  if (!confirm('Reset all budget amounts to defaults? Meal plans and shopping list will be kept.')) return;
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
  if (!confirm('This signs you out. Your cloud data stays on the server — ask the admin to delete the household if you want it gone. Continue?')) return;
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
  closeEdit, saveEdit, deleteCategory, addEntry,
  deleteEntry:       (_, d) => deleteEntry(d.id),
  resetMonthBudget:   e     => resetMonthBudget(e),

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

  // Budget view reset
  resetPlan,

  // Manual cloud refresh (tap the sync pill, or pull-to-refresh)
  refresh,
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

// Enter submits the shopping and transaction inputs.
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const id = document.activeElement?.id;
  if (id === 'shopItem')                              addShopItem();
  if (id === 'entryNote' || id === 'entryAmount')     addEntry();
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
  editModal:   closeEdit,
  addModal:    closeAdd,
  onboard:     closeOnboard,
  quickLog:    closeQuickLog,
  monthPicker: closeMonthPicker,
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
  runMigrations();
  render();   // render blank UI behind the auth modal so the page isn't empty
  await auth.getSession();
  if (cloud.session) {
    await onAuthed();
  } else {
    showAuthModal('signin');
  }
})();
