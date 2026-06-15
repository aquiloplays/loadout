// Shared helper for the /api/admin/tikfinity/* proxies.
//
// The aquilo-discord worker requires HMAC-signed requests on its
// /api/tikfinity/* surface (x-aquilo-web-{ts,sig} matching
// AQUILO_SITE_WEB_SECRET). This helper signs the outbound call and
// forwards the site session's identity so the worker can owner-gate
// the request the same way dock.js does.
//
// V1 hard-codes the owner identity to Clay (env OWNER_DISCORD_ID +
// OWNER_EMAIL). V2 should swap these for the signed-in user's
// session.subject + session.email and drop the static check; the
// worker already keys per-user state on the forwarded x-aquilo-owner-id,
// so flipping this is a one-place change.

import crypto from 'node:crypto';

const WORKER_BASE =
  process.env.WORKER_BASE
  || process.env.NEXT_PUBLIC_WORKER_BASE
  || 'https://loadout-discord.aquiloplays.workers.dev';

function signEnvelope(secret: string, ts: string, body: string): string {
  const h = crypto.createHmac('sha256', secret);
  h.update(`${ts}\n${body}`);
  return h.digest('hex');
}

export type OwnerIdentity = {
  ownerId: string;
  ownerEmail: string;
};

// V1: lift owner from env. V2: read from the signed-in session and
// gate at the session layer instead.
export function resolveOwner(): OwnerIdentity {
  return {
    ownerId: process.env.OWNER_DISCORD_ID || '1107161695262085210',
    ownerEmail: (process.env.OWNER_EMAIL || 'bisherclay@gmail.com').toLowerCase(),
  };
}

export async function proxyToWorker(opts: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
}): Promise<Response> {
  const secret = process.env.AQUILO_SITE_WEB_SECRET || '';
  if (!secret) {
    return Response.json(
      { ok: false, error: 'site-not-configured', detail: 'AQUILO_SITE_WEB_SECRET missing' },
      { status: 503 },
    );
  }
  const ts = String(Math.floor(Date.now() / 1000));
  const bodyStr = opts.body == null ? '' : JSON.stringify(opts.body);
  const sig = signEnvelope(secret, ts, bodyStr);
  const owner = resolveOwner();
  const url = `${WORKER_BASE}${opts.path}`;
  const headers: Record<string, string> = {
    'x-aquilo-web-ts': ts,
    'x-aquilo-web-sig': sig,
    'x-aquilo-owner-id': owner.ownerId,
    'x-aquilo-owner-email': owner.ownerEmail,
  };
  if (bodyStr) headers['content-type'] = 'application/json';
  try {
    const r = await fetch(url, {
      method: opts.method,
      headers,
      body: bodyStr || undefined,
    });
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { 'content-type': r.headers.get('content-type') || 'application/json' },
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: 'worker-unreachable', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
