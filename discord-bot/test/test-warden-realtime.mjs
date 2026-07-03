// BE-2 realtime smoke test: WardenRoom producer + EventSub normalization.
// Run: node test/test-warden-realtime.mjs
import assert from 'node:assert';
import { broadcastToWardenRoom } from '../aquilo/warden-room-do.js';
import { onChatMessage, onModerationEvent, WARDEN_ON_KEY } from '../warden-eventsub.js';

let pass = 0;
const t = (name, fn) => fn().then(() => { pass++; console.log('ok -', name); })
  .catch(e => { console.error('FAIL -', name, e?.message || e); process.exitCode = 1; });

// Fake WARDEN_DO that captures the ingested frame.
function fakeEnv() {
  const captured = [];
  return {
    captured,
    LOADOUT_BOLTS: { get: async () => null, put: async () => {}, delete: async () => {} },
    WARDEN_DO: {
      idFromName: (n) => ({ n }),
      get: () => ({ fetch: async (_u, opts) => { captured.push(JSON.parse(opts.body)); return new Response('{}'); } }),
    },
  };
}

await t('broadcastToWardenRoom no-ops without binding', async () => {
  const r = await broadcastToWardenRoom({}, 's1', { t: 'sys' });
  assert.equal(r.skipped, true);
});

await t('WARDEN_ON_KEY format', async () => {
  assert.equal(WARDEN_ON_KEY('123'), 'warden:on:123');
});

await t('onChatMessage normalizes + broadcasts a chat frame', async () => {
  const env = fakeEnv();
  const notification = {
    subscription: { type: 'channel.chat.message', condition: { broadcaster_user_id: '999' } },
    event: {
      broadcaster_user_id: '999',
      chatter_user_id: '42', chatter_user_login: 'SomeViewer', chatter_user_name: 'SomeViewer',
      color: '#00ff00', message_id: 'msg-1', message: { text: 'hello world' },
      badges: [{ set_id: 'subscriber', id: '0' }],
    },
  };
  const r = await onChatMessage(env, notification);
  assert.equal(r.ok, true);
  const f = env.captured.at(-1);
  assert.equal(f.t, 'chat');
  assert.equal(f.platform, 'twitch');
  assert.equal(f.id, 'msg-1');
  assert.equal(f.login, 'someviewer'); // lowercased
  assert.equal(f.text, 'hello world');
  assert.equal(f.color, '#00ff00');
  assert.deepEqual(f.badges, [{ set: 'subscriber', id: '0' }]);
});

await t('onModerationEvent (channel.moderate ban) → audit frame', async () => {
  const env = fakeEnv();
  const notification = {
    subscription: { type: 'channel.moderate', condition: { broadcaster_user_id: '999' } },
    event: {
      broadcaster_user_id: '999',
      moderator_user_id: '7', moderator_user_login: 'modguy',
      action: 'ban',
      ban: { user_id: '42', user_login: 'BadActor', reason: 'spam' },
    },
  };
  const r = await onModerationEvent(env, notification);
  assert.equal(r.ok, true);
  const f = env.captured.at(-1);
  assert.equal(f.t, 'audit');
  assert.equal(f.action, 'ban');
  // addAudit returns a D1-row-shaped object (snake_case columns). When it
  // is unavailable the handler falls back to a camelCase inline row; accept
  // either so the test is robust to whether warden-audit.js is present.
  assert.equal(f.actor_login ?? f.actorLogin, 'modguy');
  assert.equal(f.target_login ?? f.targetLogin, 'badactor'); // lowercased
  assert.equal(f.target_id ?? f.targetId, '42');
  assert.match(f.detail, /spam/);
});

await t('legacy channel.ban shape (top-level fields) normalizes', async () => {
  const env = fakeEnv();
  const notification = {
    subscription: { type: 'channel.ban', condition: { broadcaster_user_id: '999' } },
    event: {
      broadcaster_user_id: '999',
      moderator_user_id: '7', moderator_user_login: 'modguy',
      user_id: '42', user_login: 'BadActor', reason: 'rule 1',
    },
  };
  const r = await onModerationEvent(env, notification);
  assert.equal(r.ok, true);
  const f = env.captured.at(-1);
  assert.equal(f.action, 'ban');
  assert.equal(f.target_id ?? f.targetId, '42');
});

setTimeout(() => console.log(`\n${pass}/5 passed`), 50);
