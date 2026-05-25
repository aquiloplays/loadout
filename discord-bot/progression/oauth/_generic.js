// Generic OAuth 2.0 authorization code helper.
//
// Per-platform handlers (epic.js, xbox.js, battlenet.js, youtube.js,
// tiktok.js) pass their config and we drive the shared round-trip.
//
// Config shape:
//   {
//     platform:    string                — KV key prefix
//     authUrl:     string                — provider's authorize endpoint
//     tokenUrl:    string                — provider's token endpoint
//     scope:       string                — space-separated scopes
//     userFetch:   async (token, env) -> { id, handle, displayName }
//     clientIdEnv: string                — env var name for client id
//     clientSecretEnv: string            — env var name for client secret
//     extraStartParams?: object          — extra params on the auth redirect
//     extraTokenBody?: object            — extra body fields on token exchange
//   }

export function makeOAuthHandler(cfg) {
  return {
    async oauth_start(env, userId, returnUrl) {
      const callbackBase = env.PROGRESSION_CALLBACK_BASE
        || 'https://loadout-discord.aquiloplays.workers.dev';
      const clientId = env[cfg.clientIdEnv];
      if (!clientId) return { ok: false, error: `no-${cfg.platform}-client-id` };
      const state = crypto.randomUUID();
      await env.LOADOUT_BOLTS.put(
        `plink:state:${cfg.platform}:${state}`,
        JSON.stringify({ userId, returnUrl: returnUrl || '' }),
        { expirationTtl: 600 },
      );
      const ret = `${callbackBase}/web/profile/link/callback?platform=${cfg.platform}&state=${state}`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: ret,
        response_type: 'code',
        scope: cfg.scope || '',
        state,
        ...(cfg.extraStartParams || {}),
      });
      return { ok: true, redirect: `${cfg.authUrl}?${params.toString()}` };
    },

    async oauth_callback(env, query) {
      const state = query.state;
      if (!state) return { ok: false, error: 'missing-state' };
      const stateRec = await env.LOADOUT_BOLTS.get(
        `plink:state:${cfg.platform}:${state}`,
        { type: 'json' },
      );
      if (!stateRec) return { ok: false, error: 'state-expired' };
      const { userId, returnUrl } = stateRec;
      const code = query.code;
      if (!code) return { ok: false, error: 'missing-code' };

      const callbackBase = env.PROGRESSION_CALLBACK_BASE
        || 'https://loadout-discord.aquiloplays.workers.dev';
      const ret = `${callbackBase}/web/profile/link/callback?platform=${cfg.platform}&state=${state}`;
      const tokenResp = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env[cfg.clientIdEnv],
          client_secret: env[cfg.clientSecretEnv],
          code,
          grant_type: 'authorization_code',
          redirect_uri: ret,
          ...(cfg.extraTokenBody || {}),
        }).toString(),
      });
      if (!tokenResp.ok) return { ok: false, error: 'token-exchange-failed' };
      const tok = await tokenResp.json();
      let userPayload;
      try {
        userPayload = await cfg.userFetch(tok.access_token, env);
      } catch (e) {
        return { ok: false, error: 'user-fetch-failed', detail: String(e && e.message) };
      }
      if (!userPayload?.id) return { ok: false, error: 'no-user' };
      const { applyLink } = await import('../linking.js');
      const r = await applyLink(env, userId, cfg.platform, {
        externalId: String(userPayload.id),
        handle: userPayload.handle || '',
        displayName: userPayload.displayName || '',
      });
      try { await env.LOADOUT_BOLTS.delete(`plink:state:${cfg.platform}:${state}`); }
      catch { /* non-fatal */ }
      return { ...r, returnUrl };
    },
  };
}
