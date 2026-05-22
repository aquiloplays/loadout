// Xbox (Microsoft account) OAuth. Uses the Microsoft identity
// platform's "consumers" tenant for personal Microsoft accounts.
// Requires XBOX_CLIENT_ID + XBOX_CLIENT_SECRET.
//
// We only need the user's MSA sub-id + display name; full Xbox Live
// integration (XSTS token, XUID) would require a deeper handshake
// we skip until a use case demands it.
import { makeOAuthHandler } from './_generic.js';

const handler = makeOAuthHandler({
  platform: 'xbox',
  authUrl:  'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  scope:    'openid profile XboxLive.signin',
  clientIdEnv:     'XBOX_CLIENT_ID',
  clientSecretEnv: 'XBOX_CLIENT_SECRET',
  async userFetch(token, _env) {
    const r = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error('graph-me-failed');
    const d = await r.json();
    return { id: d.id, handle: d.userPrincipalName || '', displayName: d.displayName || '' };
  },
});

export const oauth_start    = handler.oauth_start;
export const oauth_callback = handler.oauth_callback;
