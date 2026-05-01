/*
 * aquilo.gg /link page - Patreon supporters self-claim their stream handles.
 *
 * Flow:
 *   1. User clicks "Connect with Patreon" → we redirect to Patreon's authorize
 *      URL with a state nonce stored in sessionStorage.
 *   2. Patreon redirects back to /link with ?code=...&state=... — we POST the
 *      code to the worker's /api/exchange endpoint (server-side: adds the
 *      client_secret, exchanges, returns the user's identity + tier + a
 *      short-lived session token).
 *   3. With the session token in memory, the user adds platform handles. Each
 *      add hits /api/handles with { platform, handle, sessionToken }.
 *   4. Worker stores the mapping in KV under a key the Loadout DLL can later
 *      look up via /api/lookup.
 *
 * Session tokens never persist to localStorage - they're memory-only and
 * expire when the tab closes. Handle list is fetched fresh each load.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const alertEl = $('alert');
  const cardConnect = $('cardConnect');
  const cardClaim = $('cardClaim');

  const WORKER_BASE = 'https://streamfusion-patreon-proxy.bisherclay.workers.dev';
  const PATREON_CLIENT_ID = 'tPN89A6Yz_NEpvQIQ2hDXcfCpyrrYha6YsgZ-aUcQP2y8Lcnaxm7-xSY8W3Zn4QO';
  const REDIRECT_URI = location.origin + location.pathname;
  const SCOPES = ['identity', 'identity.memberships'];

  let session = null;     // { token, name, tier, handles: [{platform, handle}] }

  // ── On load: handle Patreon callback if ?code= is present ─────────────────
  const url = new URL(location.href);
  if (url.searchParams.get('code')) {
    handleCallback(url.searchParams.get('code'), url.searchParams.get('state'));
  }

  $('btnConnect').addEventListener('click', startSignIn);
  $('btnAddHandle').addEventListener('click', addHandle);
  $('btnSignOut').addEventListener('click', signOut);

  function startSignIn() {
    const state = randomNonce();
    sessionStorage.setItem('aquilo.linkState', state);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: PATREON_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES.join(' '),
      state: state
    });
    location.href = 'https://www.patreon.com/oauth2/authorize?' + params.toString();
  }

  async function handleCallback(code, state) {
    const expected = sessionStorage.getItem('aquilo.linkState');
    sessionStorage.removeItem('aquilo.linkState');
    history.replaceState({}, '', REDIRECT_URI);     // strip ?code from URL
    if (!state || state !== expected) {
      showAlert('error', 'OAuth state mismatch - try again.');
      return;
    }

    try {
      const resp = await fetch(WORKER_BASE + '/api/link/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirect_uri: REDIRECT_URI })
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      session = data;        // { token, name, tier, handles }
      renderSignedIn();
      showAlert('success', 'Connected as ' + (data.name || 'a supporter') + '.');
    } catch (e) {
      showAlert('error', 'Sign-in failed: ' + e.message);
    }
  }

  async function addHandle() {
    if (!session) return;
    const platform = $('platform').value;
    const handle = $('handle').value.trim().replace(/^@+/, '');
    if (!handle) { showAlert('error', 'Enter a handle first.'); return; }

    try {
      const resp = await fetch(WORKER_BASE + '/api/link/handles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token },
        body: JSON.stringify({ platform, handle })
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      session.handles = data.handles || [];
      $('handle').value = '';
      renderHandleList();
      showAlert('success', 'Added ' + platform + ':' + handle);
    } catch (e) {
      showAlert('error', 'Add failed: ' + e.message);
    }
  }

  async function deleteHandle(platform, handle) {
    if (!session) return;
    try {
      const resp = await fetch(WORKER_BASE + '/api/link/handles', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token },
        body: JSON.stringify({ platform, handle })
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      session.handles = data.handles || [];
      renderHandleList();
    } catch (e) {
      showAlert('error', 'Remove failed: ' + e.message);
    }
  }

  function signOut() {
    session = null;
    cardClaim.style.display = 'none';
    cardConnect.style.display = '';
    showAlert('success', 'Signed out.');
  }

  function renderSignedIn() {
    cardConnect.style.display = 'none';
    cardClaim.style.display = '';
    $('patreonName').textContent = session.name || 'Patreon supporter';
    const tier = session.tier || 'none';
    const tierEl = $('patreonTier');
    tierEl.textContent = tier === 'none' ? 'No active tier' : tier.replace('tier','Tier ');
    tierEl.className = 'tier-pill tier-' + tier;
    renderHandleList();
  }

  function renderHandleList() {
    const list = $('handleList');
    list.innerHTML = '';
    if (!session.handles || session.handles.length === 0) {
      list.innerHTML = '<div style="color: var(--muted); font-size: 13px; text-align: center; padding: 16px;">No handles yet - add one above.</div>';
      return;
    }
    for (const h of session.handles) {
      const row = document.createElement('div');
      row.className = 'handle-row';
      row.innerHTML =
        '<span class="platform-tag ' + h.platform + '">' + h.platform + '</span>' +
        '<span class="handle"></span>' +
        '<button class="delete" title="Remove">×</button>';
      row.querySelector('.handle').textContent = h.handle;
      row.querySelector('.delete').addEventListener('click', () => deleteHandle(h.platform, h.handle));
      list.appendChild(row);
    }
  }

  function showAlert(kind, text) {
    alertEl.className = 'alert ' + kind;
    alertEl.textContent = text;
    if (kind === 'success') setTimeout(() => { alertEl.className = 'alert'; alertEl.textContent = ''; }, 4000);
  }

  function randomNonce() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
  }
})();
