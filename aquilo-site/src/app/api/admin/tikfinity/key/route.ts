// Owner-gated proxy for the TikFinity per-user key.
//
//   GET    /api/admin/tikfinity/key   read (or lazily create) the key
//   POST   /api/admin/tikfinity/key   ensure-key (idempotent create)
//   DELETE /api/admin/tikfinity/key   rotate (revoke old, mint new)
//
// All three forward to /api/tikfinity/key on the loadout-discord
// Worker, which is where the D1 table lives + the owner check runs.

import { proxyToWorker } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyToWorker({ method: 'GET', path: '/api/tikfinity/key' });
}

export async function POST() {
  return proxyToWorker({ method: 'POST', path: '/api/tikfinity/key', body: {} });
}

export async function DELETE() {
  return proxyToWorker({ method: 'DELETE', path: '/api/tikfinity/key' });
}
