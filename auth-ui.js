'use strict';
/* ============================================================================
   auth-ui.js — auth modal handlers + post-sign-in household wiring.

   Boundary:
     • cloud.js owns the Supabase client + the raw `auth.*` / `sync.*` API.
     • app.js owns state, render, derive, and the app screens.
     • THIS file owns the auth-modal UX — switching sign-in/sign-up tabs,
       submitting credentials, the deferred-household-setup dance for users
       who arrived back via an email-confirmation link, and the post-auth
       wiring that hydrates state and reveals the app.

   Each handler is a top-level `function` so it can be referenced by name
   from the ACTIONS registry in app.js (which dispatches the `data-action`
   attributes in index.html).
   ========================================================================== */

function showAuthModal(tab = 'signin') {
  setAuthTab(tab);
  document.getElementById('authModal').classList.add('open');
}
function hideAuthModal() {
  document.getElementById('authModal').classList.remove('open');
}

function setAuthTab(tab) {
  for (const b of document.querySelectorAll('#authTabs button')) {
    b.classList.toggle('active', b.dataset.tab === tab);
  }
  $('authFirstNameWrap').style.display = tab === 'signup' ? '' : 'none';
  $('authSignupExtras').style.display = tab === 'signup' ? '' : 'none';
  $('authSubmit').textContent = tab === 'signup' ? 'Create account' : 'Sign in';
  $('authTitle').textContent  = tab === 'signup' ? 'Create your account' : 'Sign in';
  $('authSub').textContent    = tab === 'signup'
    ? 'Email + password. Then create a new household or join with an invite code.'
    : 'Sign in to your shared household budget.';
  $('authError').style.display = 'none';
  $('authPassword').setAttribute('autocomplete', tab === 'signup' ? 'new-password' : 'current-password');
}

// Toggle the invite-code field when the user picks "Join existing".
document.addEventListener('change', e => {
  if (e.target.name === 'hhMode') {
    $('authInviteCode').style.display = e.target.value === 'join' ? '' : 'none';
  }
});

async function submitAuth() {
  const tab = document.querySelector('#authTabs button.active').dataset.tab;
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  const firstName = $('authFirstName').value.trim();
  const errEl = $('authError');
  const submitBtn = $('authSubmit');
  errEl.style.display = 'none';
  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = 'Working…';

  try {
    if (!email || !password) throw new Error('Email and password are required');
    if (tab === 'signin') {
      await auth.signIn(email, password);
    } else {
      if (!firstName) throw new Error('Enter your first name');
      const mode = document.querySelector('input[name="hhMode"]:checked').value;
      const inviteCode = $('authInviteCode').value.trim().toUpperCase();
      if (mode === 'join' && !inviteCode) throw new Error('Enter an invite code or pick "Create new"');
      const { session } = await auth.signUp(email, password, firstName);
      // Stash the household choice so it survives the email-confirmation round-trip.
      localStorage.setItem('pendingHouseholdSetup', JSON.stringify({ mode, inviteCode }));
      if (!session) throw new Error('Check your email to confirm, then sign in here.');
    }
    await onAuthed();
  } catch (e) {
    errEl.textContent = e.message || String(e);
    errEl.style.display = '';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

async function signOutNow() {
  const ok = await confirmModal({
    title: 'Sign out?',
    message: 'You can sign back in any time.',
    confirmLabel: 'Sign out',
  });
  if (!ok) return;
  await auth.signOut();
  state = blankState();
  localStorage.removeItem(STORE_KEY);
  showAuthModal('signin');
  snack('Signed out');
}

/** Called after either a fresh sign-in or a session recovered on boot. */
async function onAuthed() {
  let hid = await auth.findMyHousehold();

  // If the user signed in but has no household yet, check for a pending choice
  // stashed by submitAuth (deferred when email confirmation was required).
  if (!hid) {
    const pending = localStorage.getItem('pendingHouseholdSetup');
    if (pending) {
      try {
        const { mode, inviteCode } = JSON.parse(pending);
        if (mode === 'create') {
          await auth.createHousehold();
          await seedDefaultCategories();
        } else {
          await auth.joinHousehold(inviteCode);
        }
        localStorage.removeItem('pendingHouseholdSetup');
        hid = cloud.householdId;
      } catch (e) {
        await auth.signOut();
        showAuthModal('signup');
        $('authError').textContent = 'Household setup failed: ' + e.message;
        $('authError').style.display = '';
        return;
      }
    } else {
      await auth.signOut();
      showAuthModal('signup');
      $('authError').textContent = 'No household found. Sign up to create or join one.';
      $('authError').style.display = '';
      return;
    }
  }

  cloud.householdId = hid;
  await auth.loadHouseholdMeta();
  hideAuthModal();
  await hydrate();
  $('acctEmail').textContent  = cloud.session?.user?.email || '—';
  $('acctInvite').textContent = cloud.inviteCode || '—';
  if (!state.config.income) openOnboard(false);
}
