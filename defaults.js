'use strict';
/* ============================================================================
   defaults.js — seed values shipped with the app.

   These are the canonical opinionated defaults: the real audited Belgian
   household figures for Oduro Fosu / Dos Santos Lima, grouped by spend
   priority. Loaded BEFORE app.js so the boot path can reach them as globals.

   Treat the export as read-only at runtime — `resetPlan()` uses
   `structuredClone(DEFAULTS.categories)` to hand out a fresh mutable copy.
   ========================================================================== */

window.DEFAULTS = {
  config: { income: 3209, savings: 100, currency: '€', cofidis: true },
  categories: [
    // Fixed (locked, non-negotiable bills)
    { id:'rent',          group:'fixed',         name:'Rent',                        note:'BE10 3300 3681 6204 — 1st of month',     budget:968, locked:true,  icon:'🏠', color:'red'   },
    { id:'eneco',         group:'fixed',         name:'Energy (Eneco)',              note:'Monthly bill',                            budget:185, locked:true,  icon:'⚡', color:'amber' },
    { id:'pidpa',         group:'fixed',         name:'Water (Pidpa)',               note:'Quarterly, smoothed',                     budget:75,  locked:true,  icon:'💧', color:'blue'  },
    { id:'kbcwoning',     group:'fixed',         name:'KBC woningpolis',             note:'Renters insurance',                       budget:20,  locked:true,  icon:'🛡️', color:'blue'  },
    { id:'kbcauto',       group:'fixed',         name:'KBC autoverzekering',         note:'Audi (Tesla via Patney BV)',              budget:46,  locked:true,  icon:'🚗', color:'blue'  },
    { id:'kbcgezin',      group:'fixed',         name:'KBC gezinspolis',             note:'Quarterly, smoothed',                     budget:10,  locked:true,  icon:'👨‍👩‍👧', color:'blue'  },
    { id:'mutu',          group:'fixed',         name:'Christelijke Mutualiteit',    note:'Health insurance, 2 members',             budget:20,  locked:true,  icon:'➕', color:'green' },
    { id:'school',        group:'fixed',         name:'School / childcare',          note:'Tremelo school + Ferm + Kinderplaneet',   budget:125, locked:true,  icon:'🎒', color:'purple'},
    { id:'gemeente',      group:'fixed',         name:'Local taxes (Tremelo)',       note:'Smoothed monthly',                        budget:48,  locked:true,  icon:'🏛️', color:'grey'  },
    { id:'cofidis',       group:'fixed',         name:'Cofidis loan',                note:'Ends Jun 2026',                           budget:160, locked:true,  icon:'💳', color:'red'   },
    { id:'bankunion',     group:'fixed',         name:'Bank fees / ACV-CSC',         note:'Union dues + small bank fees',            budget:14,  locked:true,  icon:'⚙️', color:'grey'  },
    { id:'basicfit',      group:'fixed',         name:'Gym (Basic-Fit)',             note:'Cannot cancel — keep paying',             budget:23,  locked:true,  icon:'💪', color:'amber' },
    { id:'taptap',        group:'fixed',         name:'TapTap Send (family abroad)', note:'Fixed family obligation',                 budget:110, locked:true,  icon:'🌍', color:'purple'},
    { id:'rodekruis',     group:'fixed',         name:'Donations (Rode Kruis)',      note:'€9/mo SEPA — cannot pause',               budget:9,   locked:true,  icon:'❤️', color:'red'   },
    { id:'funeral',       group:'fixed',         name:'Funeral funds',               note:'Family obligation — fixed',               budget:100, locked:true,  icon:'🕯️', color:'grey'  },
    // Essentials
    { id:'groceries',     group:'essentials',    name:'Groceries',                   note:'Family of 5 — Colruyt/Aldi',              budget:600, locked:false, icon:'🛒', color:'green' },
    { id:'health',        group:'essentials',    name:'Health / pharmacy',           note:'Apotheek, dental, mutualiteit gap',       budget:100, locked:false, icon:'💊', color:'green' },
    { id:'fuel',          group:'essentials',    name:'Fuel (Audi)',                 note:'Tesla via Patney BV',                     budget:70,  locked:false, icon:'⛽', color:'amber' },
    { id:'drogist',       group:'essentials',    name:'Drogist / household',         note:'Kruidvat, Action, cleaning',              budget:50,  locked:false, icon:'🧴', color:'blue'  },
    { id:'kids',          group:'essentials',    name:'Kids clothing (3 kids)',      note:'Recurring',                               budget:60,  locked:false, icon:'👕', color:'purple'},
    { id:'familyp2p',     group:'essentials',    name:'Family P2P / Payconiq',       note:'Gifts, school, transfers',                budget:150, locked:false, icon:'💌', color:'purple'},
    // Discretionary
    { id:'restaurants',   group:'discretionary', name:'Restaurants & dining',        note:'1 family meal / 2 weeks max',             budget:80,  locked:false, icon:'🍽️', color:'amber' },
    { id:'shopping',      group:'discretionary', name:'Online shopping',             note:'Amazon, Bol — consolidated',              budget:60,  locked:false, icon:'📦', color:'blue'  },
    { id:'clothing',      group:'discretionary', name:'Adult clothing',              note:'One small purchase / month',              budget:30,  locked:false, icon:'👔', color:'blue'  },
    { id:'hair',          group:'discretionary', name:'Hair (Blessco)',              note:'Every 5–6 weeks',                         budget:40,  locked:false, icon:'💇', color:'purple'},
    { id:'atm',           group:'discretionary', name:'ATM cash',                    note:'~€30/wk max',                             budget:40,  locked:false, icon:'💶', color:'green' },
    { id:'travel',        group:'discretionary', name:'Travel fund',                 note:'Annual trip pot',                         budget:60,  locked:false, icon:'✈️', color:'blue'  },
    { id:'snacks',        group:'discretionary', name:'Snacks',                      note:'For wife & kids',                         budget:25,  locked:false, icon:'🍪', color:'amber' },
    { id:'kinderplezier', group:'discretionary', name:'Kinderplezier',               note:'Books & treats for the kids',             budget:40,  locked:false, icon:'📚', color:'purple'},
  ],
  entries:         {},  // entries[YYYY-MM][catId] = [{ id, amount, note, date }]
  meals:           {},  // meals[YYYY-MM-DD]       = { dinner, … }
  shopping:        {},  // shopping[YYYY-MM][week] = [{ id, item, done }]
  budgetOverrides: {},  // budgetOverrides[YYYY-MM][catId] = number
  flags:           {},  // one-shot guards for migrations/seeds
};
