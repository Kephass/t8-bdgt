'use strict';
/* ============================================================================
   migrations.js — upgrade older persisted shapes + one-shot seeds.

   Called once from boot() in app.js, BEFORE the first render. Each function
   reads/mutates the global `state` declared in app.js and calls the global
   `save()` to persist when needed — keeping the same locality of effect as
   when these lived inline at the top of app.js.

   Register new migrations in `runMigrations()`. They must be idempotent:
   the same persisted shape may pass through multiple boots before the user
   triggers anything that bumps the schema.
   ========================================================================== */

function runMigrations() {
  migrateActuals();
  migrateShopping();
}

/** Legacy { actuals[month][catId] = amount } → explicit entries. */
function migrateActuals() {
  if (!state.actuals || !Object.keys(state.actuals).length) return;
  for (const m in state.actuals) {
    state.entries[m] ||= {};
    for (const catId in state.actuals[m]) {
      const amount = +state.actuals[m][catId] || 0;
      if (amount <= 0) continue;
      (state.entries[m][catId] ||= []).push({
        id: newId(), amount, note: 'Migrated total', date: m + '-15',
      });
    }
  }
  delete state.actuals;
  save();
}

/** Shopping: flat array OR un-scoped weeks → month-scoped 4-week buckets. */
function migrateShopping() {
  const blank = () => ({ '1': [], '2': [], '3': [], '4': [] });
  const clean = it => ({ id: it.id, item: it.item, done: !!it.done });
  const s = state.shopping;

  if (Array.isArray(s)) {
    const weeks = blank();
    weeks['1'] = s.map(clean);
    state.shopping = { [thisMonth()]: weeks };
    save();
    return;
  }
  if (!s || typeof s !== 'object') { state.shopping = {}; return; }

  const keys = Object.keys(s);
  const isUnscoped = keys.length > 0 && keys.every(k => ['1','2','3','4'].includes(k));
  if (isUnscoped) {
    const weeks = blank();
    for (const w of ['1','2','3','4']) weeks[w] = (s[w] || []).map(clean);
    state.shopping = { [thisMonth()]: weeks };
    save();
    return;
  }
  // Already month-scoped — normalize items and ensure all 4 weeks exist
  for (const m in s) {
    const month = s[m] || {};
    for (const w of ['1','2','3','4']) month[w] = (month[w] || []).map(clean);
    s[m] = month;
  }
}

/** One-shot seed: the May 2026 cashflow-rescue plan from the Numbers sheet. */
function seedRescueMonth() {
  if (state.flags.may2026rescue) return;

  const ensure = cat => {
    if (!state.categories.find(c => c.id === cat.id)) state.categories.push(cat);
  };
  ensure({ id:'funeral',       group:'fixed',         name:'Funeral funds', note:'Family obligation — fixed',   budget:100, locked:true,  icon:'🕯️', color:'grey'   });
  ensure({ id:'snacks',        group:'discretionary', name:'Snacks',        note:'For wife & kids',             budget:25,  locked:false, icon:'🍪', color:'amber'  });
  ensure({ id:'kinderplezier', group:'discretionary', name:'Kinderplezier', note:'Books & treats for the kids', budget:40,  locked:false, icon:'📚', color:'purple' });

  const seed = [ /* [catId, amount, note, day] */
    ['rent',          968.05, 'Rent — 1 May',                                  1],
    ['eneco',         184.46, 'Eneco — April catch-up (deferred bill)',        5],
    ['pidpa',         226.00, 'Pidpa water — single-month payment',            8],
    ['kbcwoning',      19.82, 'KBC woningpolis (May premium)',                 5],
    ['school',         47.88, 'Childcare — OCMW',                              5],
    ['school',         29.00, 'School kids — Klimboom',                       10],
    ['cofidis',       160.13, 'Cofidis loan — one of last instalments',        5],
    ['bankunion',      13.83, 'Bank fees + ACV-CSC',                           5],
    ['groceries',     571.60, 'Groceries (compressed, discount-store run)',   15],
    ['health',         28.05, 'Pharmacy — necessities only',                  10],
    ['fuel',           70.04, 'Fuel — Audi',                                   8],
    ['drogist',        39.18, 'Drogist / household — bare necessities',       12],
    ['kids',           20.00, "Kids' clothes",                                15],
    ['familyp2p',      10.00, 'Family P2P — essentials only',                 12],
    ['funeral',       100.00, 'Funeral funds',                                 5],
    ['snacks',          1.79, 'Snacks for the kids',                          14],
    ['basicfit',       23.00, 'Gym (Basic-Fit) — cannot cancel',               1],
    ['atm',            40.00, 'ATM cash — tight cap',                         10],
    ['taptap',        110.00, 'TapTap Send — family abroad',                   5],
    ['rodekruis',       9.00, 'Rode Kruis SEPA',                               5],
    ['kinderplezier',  33.90, 'Books for the kids',                           18],
  ];
  state.entries['2026-05'] ||= {};
  for (const [catId, amount, note, day] of seed) {
    (state.entries['2026-05'][catId] ||= []).push({
      id: newId(), amount, note, date: `2026-05-${pad2(day)}`,
    });
  }
  state.flags.may2026rescue = true;
  save();
}
