// TikTok OAuth (TikTok for Developers app). Requires
// TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET.
import { makeOAuthHandler } from './_generic.js';

const handler = makeOAuthHandler({
  platform: 'tiktok',
  authUrl:  'https://www.tiktok.com/v2/auth/authorize/',
  tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
  scope:    'user.info.basic',
  clientIdEnv:     'TIKTOK_CLIENT_KEY',
  clientSecretEnv: 'TIKTOK_CLIENT_SECRET',
  async userFetch(token, _env) {
    const r = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error('tiktok-userinfo-failed');
    const d = await r.json();
    const u = d?.data?.user;
    if (!u?.open_id) throw new Error('no-tiktok-user');
    return { id: u.open_id, handle: u.username || '', displayName: u.display_name || '' };
  },
});

export const oauth_start    = handler.oauth_start;
export const oauth_callback = handler.oauth_callback;
