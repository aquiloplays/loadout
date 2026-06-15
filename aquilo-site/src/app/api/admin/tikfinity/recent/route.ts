// Polled by the wizard's "Waiting for test event..." card every 2s
// to detect inbound TikFinity events. See tikfinity-keys.js on the
// worker for the response shape.

import { proxyToWorker } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyToWorker({ method: 'GET', path: '/api/tikfinity/recent' });
}
