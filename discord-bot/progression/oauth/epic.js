// Epic Games OAuth, needs EPIC_CLIENT_ID + EPIC_CLIENT_SECRET set on
// the worker (registered via Epic Developer Portal).
import { makeOAuthHandler } from './_generic.js';

const handler = makeOAuthHandler({
  platform: 'epic',
  authUrl:  'https://www.epicgames.com/id/authorize',
  tokenUrl: 'https://api.epicgames.dev/epic/oauth/v2/token',
  scope:    'basic_profile',
  clientIdEnv:     'EPIC_CLIENT_ID',
  clientSecretEnv: 'EPIC_CLIENT_SECRET',
  async userFetch(token, env) {
    const r = await fetch('https://api.epicgames.dev/epic/oauth/v2/userInfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error('epic-userinfo-failed');
    const d = await r.json();
    return { id: d.sub, handle: d.preferred_username || '', displayName: d.display_name || d.preferred_username || '' };
  },
});

export const oauth_start    = handler.oauth_start;
export const oauth_callback = handler.oauth_callback;
