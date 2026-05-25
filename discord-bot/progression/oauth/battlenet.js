// Battle.net OAuth (Blizzard developer portal). Requires
// BNET_CLIENT_ID + BNET_CLIENT_SECRET.
import { makeOAuthHandler } from './_generic.js';

const handler = makeOAuthHandler({
  platform: 'battlenet',
  authUrl:  'https://oauth.battle.net/authorize',
  tokenUrl: 'https://oauth.battle.net/token',
  scope:    'openid',
  clientIdEnv:     'BNET_CLIENT_ID',
  clientSecretEnv: 'BNET_CLIENT_SECRET',
  async userFetch(token, _env) {
    const r = await fetch('https://oauth.battle.net/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error('bnet-userinfo-failed');
    const d = await r.json();
    return { id: d.id, handle: d.battletag || '', displayName: d.battletag || '' };
  },
});

export const oauth_start    = handler.oauth_start;
export const oauth_callback = handler.oauth_callback;
