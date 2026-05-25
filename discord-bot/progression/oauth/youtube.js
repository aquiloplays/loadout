// YouTube via Google OAuth. Requires YOUTUBE_CLIENT_ID +
// YOUTUBE_CLIENT_SECRET (Google Cloud Project, OAuth consent screen).
import { makeOAuthHandler } from './_generic.js';

const handler = makeOAuthHandler({
  platform: 'youtube',
  authUrl:  'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope:    'https://www.googleapis.com/auth/youtube.readonly',
  clientIdEnv:     'YOUTUBE_CLIENT_ID',
  clientSecretEnv: 'YOUTUBE_CLIENT_SECRET',
  extraStartParams: { access_type: 'online', prompt: 'select_account' },
  async userFetch(token, _env) {
    const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error('yt-channels-failed');
    const d = await r.json();
    const c = d?.items?.[0];
    if (!c?.id) throw new Error('no-yt-channel');
    return {
      id: c.id,
      handle: c.snippet?.customUrl || '',
      displayName: c.snippet?.title || '',
    };
  },
});

export const oauth_start    = handler.oauth_start;
export const oauth_callback = handler.oauth_callback;
