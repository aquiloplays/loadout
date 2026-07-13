#!/usr/bin/env node
// Sign + POST /admin/guild-seed-config/<guildId> using the site-admin HMAC
// (headers x-aquilo-web-{ts,sig}; hex SHA-256 over `${ts}\n${body}`, the
// scheme verifyHmac() in auth.js validates). Snapshots a guild's deploy-time
// [vars] wiring (SEED_KEYS) into per-guild KV config:<guildId>:<KEY>.
//
// Run (secret via env OR ./.dev.vars):
//   AQUILO_SITE_WEB_SECRET=<secret> \
//     node seed-guild-config.mjs [guildId] [--activate] [--keys=A,B] [--url=https://...]
//
// Defaults: guildId = 1504103035951906883 (Aquilo),
//           url = https://loadout-discord.aquiloplays.workers.dev
import crypto from 'node:crypto';
import fs from 'node:fs';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--') && !a.includes('=')));
const getFlag = (name) => {
  const f = args.find(a => a.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : null;
};
const positional = args.filter(a => !a.startsWith('--'));
const guildId  = positional[0] || '1504103035951906883';
const base     = (getFlag('url') || 'https://loadout-discord.aquiloplays.workers.dev').replace(/\/$/, '');
const activate = flags.has('--activate');
const keysArg  = getFlag('keys');

// Fallback: load secret from ./.dev.vars (git-ignored) if not in env.
if (!process.env.AQUILO_SITE_WEB_SECRET) {
  try {
    const txt = fs.readFileSync(new URL('./.dev.vars', import.meta.url), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] == null) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .dev.vars — rely on env */ }
}

const secret = process.env.AQUILO_SITE_WEB_SECRET;
if (!secret) {
  console.error('Missing AQUILO_SITE_WEB_SECRET (set it in env or ./.dev.vars).');
  process.exit(1);
}
if (/REPLACE_WITH/i.test(secret)) {
  console.error('AQUILO_SITE_WEB_SECRET is still the placeholder — paste the real secret into ./.dev.vars first.');
  process.exit(1);
}

const bodyObj = { activate };
if (keysArg) bodyObj.keys = keysArg.split(',').map(s => s.trim()).filter(Boolean);
const body = JSON.stringify(bodyObj);

const ts  = Math.floor(Date.now() / 1000).toString();
const sig = crypto.createHmac('sha256', secret).update(ts + '\n' + body).digest('hex');
const url = `${base}/admin/guild-seed-config/${encodeURIComponent(guildId)}`;

console.log(`POST ${url}`);
console.log(`body ${body}`);
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-aquilo-web-ts': ts,
    'x-aquilo-web-sig': sig,
  },
  body,
});
const text = await res.text();
console.log(`\n${res.status} ${res.statusText}`);
console.log(text);
process.exit(res.ok ? 0 : 2);
