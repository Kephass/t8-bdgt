'use strict';
/* ============================================================================
   cloud.js — Supabase auth + local-first sync layer for Family Budget.

   Architecture:
     • `sb`     — Supabase JS client (created from window.SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY)
     • `auth`   — wraps sign-in / sign-up / sign-out + tracks current session
     • `sync`   — typed operations (upsert/delete) for each table.
                  Every action in app.js calls one of these AFTER its commit().
     • `hydrate()` — fetches the household's data on sign-in and reseats
                     localStorage state so the existing render path "just works".

   Local-first invariant: commit() always wins locally first; sync.* fires
   in the background. Failures are logged + surfaced via the sync indicator,
   never thrown back into the action path.
   ========================================================================== */

const HAS_CONFIG = !!(window.SUPABASE_URL && window.SUPABASE_PUBLISHABLE_KEY);
if (!HAS_CONFIG) {
  document.addEventListener('DOMContentLoaded', () => {
    document.body.innerHTML = `
      <div style="max-width:520px;margin:80px auto;padding:24px;background:#1a1d23;color:#e8eaed;border:1px solid #383b41;border-radius:12px;font:14px/1.5 -apple-system,system-ui,sans-serif">
        <h2 style="margin:0 0 12px;color:#ee5a5a">Missing Supabase config</h2>
        <p>Copy <code style="background:#0f1115;padding:2px 6px;border-radius:4px">config.example.js</code> to <code style="background:#0f1115;padding:2px 6px;border-radius:4px">config.js</code> and fill in your Supabase project URL + publishable key.</p>
        <p style="color:#8a8f98;margin-top:12px">Find them in your Supabase dashboard → Settings → API.</p>
      </div>`;
  });
  throw new Error('Missing Supabase config');
}

if (!window.supabase || typeof window.supabase.createClient !== 'function') {
  throw new Error('Supabase JS client failed to load — check network / CDN');
}

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

/* ── Cloud state — household id is captured once on sign-in ─────────────── */

const cloud = {
  session:       null,
  householdId:   null,
  inviteCode:    null,
  pending:       0,         // in-flight sync ops, drives the indicator
  lastError:     null,
  lastSyncedAt:  null,      // ms timestamp of the most recent successful sync
};

function syncedAgeLabel() {
  if (!cloud.lastSyncedAt) return 'Synced';
  const seconds = Math.floor((Date.now() - cloud.lastSyncedAt) / 1000);
  if (seconds < 60)            return 'Synced';
  const mins = Math.floor(seconds / 60);
  if (mins < 60)               return `Synced ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24)              return `Synced ${hours}h ago`;
  return 'Synced 1d+ ago';
}

function setStatus(text, kind = 'ok') {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  el.dataset.kind = kind;
  el.textContent  = (kind === 'ok') ? syncedAgeLabel() : text;
}

// Tick the displayed age once a minute so "Synced" rolls into "Synced 1m"
// without waiting for the next sync.
setInterval(() => {
  const el = document.getElementById('syncStatus');
  if (el && el.dataset.kind === 'ok') el.textContent = syncedAgeLabel();
}, 60000);

function note(op, err) {
  if (!err) return;
  cloud.lastError = err.message || String(err);
  console.error('[cloud]', op, err);
  setStatus('Sync error — see console', 'err');
}

async function track(op, fn) {
  cloud.pending++;
  setStatus('Syncing…', 'busy');
  try {
    const result = await fn();
    return result;
  } catch (err) {
    note(op, err);
    return null;
  } finally {
    cloud.pending--;
    if (cloud.pending === 0 && !cloud.lastError) {
      cloud.lastSyncedAt = Date.now();
      setStatus('Synced', 'ok');
    }
  }
}

/* ── Auth ────────────────────────────────────────────────────────────────── */

const auth = {
  async signIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    cloud.session = data.session;
    return data;
  },

  async signUp(email, password, firstName = '') {
    const { data, error } = await sb.auth.signUp({
      email, password,
      // first_name lives in the user's auth metadata — it's per-user (each
      // member of a shared household has their own), so it does NOT belong in
      // the household config. No schema/migration needed.
      options: { data: { first_name: firstName.trim() } },
    });
    if (error) throw error;
    cloud.session = data.session;
    return data;
  },

  /** First name from the signed-in user's auth metadata, or '' if unset. */
  firstName() {
    return cloud.session?.user?.user_metadata?.first_name || '';
  },

  /** Update the signed-in user's first name in auth metadata. */
  async updateProfile({ firstName }) {
    const { data, error } = await sb.auth.updateUser({ data: { first_name: (firstName || '').trim() } });
    if (error) throw error;
    if (cloud.session) cloud.session.user = data.user;  // reflect locally
    return data.user;
  },

  async signOut() {
    await sb.auth.signOut();
    cloud.session = null;
    cloud.householdId = null;
    cloud.inviteCode = null;
  },

  async getSession() {
    const { data: { session } } = await sb.auth.getSession();
    cloud.session = session;
    return session;
  },

  async createHousehold() {
    const { data, error } = await sb.rpc('create_household');
    if (error) throw error;
    cloud.householdId = data;
    return data;
  },

  async joinHousehold(inviteCode) {
    const { data, error } = await sb.rpc('join_household', { p_invite_code: inviteCode });
    if (error) throw error;
    cloud.householdId = data;
    return data;
  },

  /** Find the user's existing household, if any. Returns null when they're new. */
  async findMyHousehold() {
    if (!cloud.session) return null;
    const { data, error } = await sb
      .from('household_members')
      .select('household_id')
      .eq('user_id', cloud.session.user.id)
      .maybeSingle();
    if (error) throw error;
    return data?.household_id || null;
  },

  async loadHouseholdMeta() {
    if (!cloud.householdId) return;
    const { data, error } = await sb
      .from('households')
      .select('invite_code')
      .eq('id', cloud.householdId)
      .single();
    if (error) throw error;
    cloud.inviteCode = data.invite_code;
  },

  async rotateInviteCode() {
    const { data, error } = await sb.rpc('rotate_invite_code');
    if (error) throw error;
    cloud.inviteCode = data;
    return data;
  },

  async listMembers() {
    const { data, error } = await sb.rpc('list_household_members');
    if (error) throw error;
    return data || [];
  },

  async removeMember(userId) {
    const { error } = await sb.rpc('remove_household_member', { target: userId });
    if (error) throw error;
  },
};

/* ── Hydration: pull the whole household's state from Supabase ──────────── */

async function hydrate() {
  if (!cloud.householdId) return;
  setStatus('Loading…', 'busy');

  const hid = cloud.householdId;
  const [
    { data: households, error: e1 },
    { data: categories, error: e2 },
    { data: entries,    error: e3 },
    { data: meals,      error: e4 },
    { data: shopping,   error: e5 },
    { data: overrides,  error: e6 },
    { data: wants,      error: e7 },
    { data: incomeOv,   error: e8 },
  ] = await Promise.all([
    sb.from('households').select('income, savings, currency, cofidis').eq('id', hid).single(),
    sb.from('categories').select('*').eq('household_id', hid).order('sort_order'),
    sb.from('entries').select('*').eq('household_id', hid),
    sb.from('meals').select('*').eq('household_id', hid),
    sb.from('shopping_items').select('*').eq('household_id', hid),
    sb.from('budget_overrides').select('*').eq('household_id', hid),
    sb.from('wants').select('*').eq('household_id', hid),
    sb.from('income_overrides').select('month_key, amount').eq('household_id', hid),
  ]);
  // Core tables are all-or-nothing. income_overrides is intentionally NOT in
  // this list: it's a newer, supplementary table, so if it's missing (e.g. the
  // migration hasn't been applied yet) the rest of the household still loads —
  // per-month income just falls back to the global default until then.
  const err = e1 || e2 || e3 || e4 || e5 || e6 || e7;
  if (err) { note('hydrate', err); return; }
  if (e8) console.warn('[cloud] hydrate: income_overrides unavailable —', e8.message || e8);

  // Reseat the in-memory state to match what came down.
  state.config = {
    income:   +households.income   || 0,
    savings:  +households.savings  || 0,
    currency: households.currency  || '€',
    cofidis:  !!households.cofidis,
  };
  state.categories = categories.map(c => ({
    id: c.id, group: c.group, name: c.name, note: c.note || '',
    budget: +c.budget || 0, locked: !!c.locked,
    icon: c.icon || '•', color: c.color || 'grey',
  }));
  state.entries = {};
  for (const e of entries) {
    ((state.entries[e.month_key] ||= {})[e.category_id] ||= []).push({
      id: e.id, amount: +e.amount, note: e.note || '', date: e.spent_on,
    });
  }
  state.meals = {};
  for (const m of meals) {
    state.meals[m.on_date] = {
      dinner: m.dinner || '', breakfast: m.breakfast || '',
      lunch: m.lunch || '', notes: m.notes || '',
    };
  }
  state.shopping = {};
  for (const s of shopping) {
    const month = (state.shopping[s.month_key] ||= { '1':[],'2':[],'3':[],'4':[] });
    month[String(s.week_num)].push({ id: s.id, item: s.item, done: !!s.done });
  }
  state.budgetOverrides = {};
  for (const o of overrides) {
    (state.budgetOverrides[o.month_key] ||= {})[o.category_id] = +o.amount;
  }
  state.incomeOverrides = {};
  for (const o of (incomeOv || [])) {
    state.incomeOverrides[o.month_key] = +o.amount;
  }
  state.wants = (wants || []).map(w => ({
    id: w.id, item: w.item, done: !!w.done, boughtAt: w.bought_at || null,
  }));

  save();   // mirror to localStorage
  render();
  cloud.lastSyncedAt = Date.now();
  setStatus('Synced', 'ok');
}

/* ── Sync operations — called from each action AFTER its commit() ───────── */

const sync = {
  // ── households / config ────────────────────────────────────────────────
  updateConfig(patch) {
    if (!cloud.householdId) return;
    track('updateConfig', async () => {
      const { error } = await sb.from('households').update(patch).eq('id', cloud.householdId);
      if (error) throw error;
    });
  },

  // ── categories ─────────────────────────────────────────────────────────
  upsertCategory(cat, sortOrder = null) {
    if (!cloud.householdId) return;
    const row = {
      household_id: cloud.householdId,
      id:    cat.id,
      group: cat.group,
      name:  cat.name,
      note:  cat.note || '',
      budget: +cat.budget || 0,
      locked: !!cat.locked,
      icon:   cat.icon || '•',
      color:  cat.color || 'grey',
    };
    if (sortOrder != null) row.sort_order = sortOrder;
    track('upsertCategory', async () => {
      const { error } = await sb.from('categories').upsert(row);
      if (error) throw error;
    });
  },
  deleteCategory(catId) {
    if (!cloud.householdId) return;
    track('deleteCategory', async () => {
      const { error } = await sb.from('categories')
        .delete().eq('household_id', cloud.householdId).eq('id', catId);
      if (error) throw error;
    });
  },

  // ── entries ────────────────────────────────────────────────────────────
  upsertEntry(catId, entry) {
    if (!cloud.householdId) return;
    const monthKey = (entry.date || '').slice(0, 7);
    track('upsertEntry', async () => {
      const { error } = await sb.from('entries').upsert({
        id: entry.id,
        household_id: cloud.householdId,
        category_id: catId,
        month_key: monthKey,
        amount: +entry.amount,
        note: entry.note || '',
        spent_on: entry.date,
      });
      if (error) throw error;
    });
  },
  deleteEntry(entryId) {
    if (!cloud.householdId) return;
    track('deleteEntry', async () => {
      const { error } = await sb.from('entries').delete().eq('id', entryId);
      if (error) throw error;
    });
  },

  // ── meals ──────────────────────────────────────────────────────────────
  upsertMeal(dateKey, fields) {
    if (!cloud.householdId) return;
    track('upsertMeal', async () => {
      const { error } = await sb.from('meals').upsert({
        household_id: cloud.householdId,
        on_date: dateKey,
        dinner:    fields.dinner    || null,
        breakfast: fields.breakfast || null,
        lunch:     fields.lunch     || null,
        notes:     fields.notes     || null,
      });
      if (error) throw error;
    });
  },
  deleteMeal(dateKey) {
    if (!cloud.householdId) return;
    track('deleteMeal', async () => {
      const { error } = await sb.from('meals')
        .delete().eq('household_id', cloud.householdId).eq('on_date', dateKey);
      if (error) throw error;
    });
  },

  // ── shopping ───────────────────────────────────────────────────────────
  upsertShopItem(monthKey, week, item) {
    if (!cloud.householdId) return;
    track('upsertShopItem', async () => {
      const { error } = await sb.from('shopping_items').upsert({
        id: item.id,
        household_id: cloud.householdId,
        month_key: monthKey,
        week_num: +week,
        item: item.item,
        done: !!item.done,
      });
      if (error) throw error;
    });
  },
  deleteShopItem(itemId) {
    if (!cloud.householdId) return;
    track('deleteShopItem', async () => {
      const { error } = await sb.from('shopping_items').delete().eq('id', itemId);
      if (error) throw error;
    });
  },

  // ── needs & wants ──────────────────────────────────────────────────────
  upsertWant(want) {
    if (!cloud.householdId) return;
    track('upsertWant', async () => {
      const { error } = await sb.from('wants').upsert({
        id: want.id,
        household_id: cloud.householdId,
        item: want.item,
        done: !!want.done,
        bought_at: want.boughtAt || null,
      });
      if (error) throw error;
    });
  },
  deleteWant(itemId) {
    if (!cloud.householdId) return;
    track('deleteWant', async () => {
      const { error } = await sb.from('wants').delete().eq('id', itemId);
      if (error) throw error;
    });
  },

  // ── budget overrides ───────────────────────────────────────────────────
  upsertOverride(monthKey, catId, amount) {
    if (!cloud.householdId) return;
    track('upsertOverride', async () => {
      const { error } = await sb.from('budget_overrides').upsert({
        household_id: cloud.householdId,
        month_key: monthKey,
        category_id: catId,
        amount: +amount,
      });
      if (error) throw error;
    });
  },
  deleteOverride(monthKey, catId) {
    if (!cloud.householdId) return;
    track('deleteOverride', async () => {
      const { error } = await sb.from('budget_overrides').delete()
        .eq('household_id', cloud.householdId)
        .eq('month_key', monthKey)
        .eq('category_id', catId);
      if (error) throw error;
    });
  },

  // ── income overrides ───────────────────────────────────────────────────
  upsertIncomeOverride(monthKey, amount) {
    if (!cloud.householdId) return;
    track('upsertIncomeOverride', async () => {
      const { error } = await sb.from('income_overrides').upsert({
        household_id: cloud.householdId,
        month_key: monthKey,
        amount: +amount,
      });
      if (error) throw error;
    });
  },
  deleteIncomeOverride(monthKey) {
    if (!cloud.householdId) return;
    track('deleteIncomeOverride', async () => {
      const { error } = await sb.from('income_overrides').delete()
        .eq('household_id', cloud.householdId)
        .eq('month_key', monthKey);
      if (error) throw error;
    });
  },
};

/* ── Default-category seeding (called after create_household RPC) ───────── */

async function seedDefaultCategories() {
  if (!cloud.householdId) return;
  const rows = DEFAULTS.categories.map((c, i) => ({
    household_id: cloud.householdId,
    id: c.id,
    group: c.group,
    name: c.name,
    note: c.note || '',
    budget: +c.budget || 0,
    locked: !!c.locked,
    icon:  c.icon || '•',
    color: c.color || 'grey',
    sort_order: i,
  }));
  const { error } = await sb.from('categories').upsert(rows);
  if (error) throw error;
}

window.cloud = cloud;
window.sb    = sb;
window.auth  = auth;
window.sync  = sync;
window.hydrate = hydrate;
window.seedDefaultCategories = seedDefaultCategories;
