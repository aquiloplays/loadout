// Wizard "Test it" button: triggers a synthetic event through the
// keyed ingest path so the user can verify the round-trip without a
// real viewer. Skipped from leaderboards by the test=true flag.

import { proxyToWorker } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  return proxyToWorker({ method: 'POST', path: '/api/tikfinity/test-fire', body: {} });
}
