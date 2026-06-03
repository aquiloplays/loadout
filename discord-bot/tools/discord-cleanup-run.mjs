// Driver for the one-shot Discord cleanup + menu-channel lockdown.
//
// Talks to the deployed worker's /admin/discord/cleanup/<guild>/<token>
// route, one channel per call (the worker keeps each request under the
// subrequest budget; this loop sequences them and aggregates the report).
//
// Re-runnable / idempotent: already-cleaned channels report 0 deleted.
//
// Env:
//   CLEANUP_TOKEN   required, matches KV bootstrap-discord-cleanup-token
//   GUILD_ID        default 1504103035951906883 (Aquilo guild)
//   WORKER_BASE     default https://loadout-discord.aquiloplays.workers.dev
//   RUN_ID          default cleanup-<unix>  (shared archive key namespace)
//   DRY_RUN         '1' -> plan + print only, no deletes / no lockdown

const token = process.env.CLEANUP_TOKEN;
if (!token) { console.error('CLEANUP_TOKEN required'); process.exit(1); }
const guildId = process.env.GUILD_ID || '1504103035951906883';
const base = (process.env.WORKER_BASE || 'https://loadout-discord.aquiloplays.workers.dev').replace(/\/$/, '');
const runId = process.env.RUN_ID || `cleanup-${Math.floor(Date.now() / 1000)}`;
const dryRun = process.env.DRY_RUN === '1';
const root = `${base}/admin/discord/cleanup/${guildId}/${token}`;

async function call(qs) {
  const r = await fetch(`${root}?${qs}`, { method: 'POST' });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { ok: false, raw: text.slice(0, 300) }; }
  return { status: r.status, json };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`# Discord cleanup run`);
  console.log(`  guild=${guildId} runId=${runId} dryRun=${dryRun}`);
  console.log(`  worker=${base}\n`);

  // 1. PLAN
  const { status: pStatus, json: plan } = await call('mode=plan');
  if (!plan.ok) { console.error('PLAN failed:', pStatus, JSON.stringify(plan).slice(0, 400)); process.exit(1); }
  console.log(`## Plan`);
  console.log(`  clean targets : ${plan.clean.length}`);
  console.log(`  preserved     : ${plan.preserve.length}`);
  console.log(`  menu (lock)   : ${plan.menu.length}`);
  console.log(`  skipped       : ${plan.skipped.length}`);
  if (plan.errors?.length) console.log(`  plan errors   : ${JSON.stringify(plan.errors)}`);
  console.log('');
  console.log('  Preserved:');
  for (const c of plan.preserve) console.log(`    - #${c.name} (${c.id}) [${c.reason}]${c.isMenu ? ' MENU' : ''}`);
  console.log('  Menu channels to lock:');
  for (const c of plan.menu) console.log(`    - #${c.name} (${c.id}) [${c.reason}]`);
  console.log('  Channels to clean:');
  for (const c of plan.clean) console.log(`    - #${c.name} (${c.id}) [${c.kind}/${c.reason}]`);
  console.log('');

  if (dryRun) { console.log('DRY_RUN=1 -> stopping before any delete/lockdown.'); return; }

  // 2. CLEAN each target (forum containers flagged).
  const cleanReport = [];
  for (const c of plan.clean) {
    const isForum = c.kind === 'forum';
    const qs = new URLSearchParams({ mode: 'clean', channel: c.id, runId,
      name: c.name || '' });
    if (isForum) qs.set('forum', '1');
    let attempt = 0, res;
    while (attempt < 5) {
      res = await call(qs.toString());
      if (res.json.ok) break;
      attempt++;
      console.log(`    retry ${attempt} for #${c.name} (${res.status})`);
      await sleep(1500);
    }
    const j = res.json;
    if (isForum) {
      console.log(`  [forum] #${c.name}: threadsScanned=${j.threadsScanned ?? '?'} deletedThreads=${j.deletedThreads ?? '?'} keptThreads=${j.keptThreads ?? '?'} archived=${j.archived ?? '?'}`);
    } else {
      console.log(`  #${c.name}: scanned=${j.scanned ?? '?'} archived=${j.archived ?? '?'} deleted=${j.deleted ?? '?'} pinnedKept=${j.kept?.pinned ?? '?'}${j.truncated ? ' TRUNCATED' : ''}${j.errors?.length ? ` errors=${j.errors.length}` : ''}`);
    }
    cleanReport.push({ id: c.id, name: c.name, kind: c.kind, ...j });
    await sleep(400);   // gentle pacing between channels
  }
  console.log('');

  // 3. LOCKDOWN each menu channel.
  const lockReport = [];
  console.log(`## Permission lockdown`);
  for (const c of plan.menu) {
    const res = await call(`mode=lockdown&channel=${c.id}`);
    const j = res.json;
    console.log(`  #${c.name} (${c.id}): ${j.ok ? 'LOCKED' : 'FAILED'} applied=[${(j.applied || []).join(', ')}]${j.errors?.length ? ` errors=${JSON.stringify(j.errors)}` : ''}`);
    lockReport.push({ id: c.id, name: c.name, ...j });
    await sleep(300);
  }
  console.log('');

  // 4. VERIFY: sample cleaned channels (empty/pinned-only) + lock state.
  console.log(`## Verify`);
  let cleanVerified = 0, cleanDirty = 0;
  for (const c of plan.clean.filter(c => c.kind !== 'forum')) {
    const res = await call(`mode=verify&channel=${c.id}`);
    const s = res.json.sample;
    if (s?.clean) cleanVerified++;
    else { cleanDirty++; console.log(`  ! #${c.name}: ${s?.nonPinned ?? '?'} non-pinned remain`); }
    await sleep(150);
  }
  console.log(`  cleaned channels empty/pinned-only: ${cleanVerified}/${plan.clean.filter(c => c.kind !== 'forum').length}${cleanDirty ? ` (${cleanDirty} still have messages)` : ''}`);
  let lockVerified = 0;
  for (const c of plan.menu) {
    const res = await call(`mode=verify&channel=${c.id}`);
    if (res.json.lock?.everyoneSendDenied) lockVerified++;
    else console.log(`  ! #${c.name}: @everyone send NOT denied`);
    await sleep(150);
  }
  console.log(`  menu channels @everyone-send-denied: ${lockVerified}/${plan.menu.length}`);
  console.log('');

  // 5. Archive retrievability spot-check (first cleaned non-forum channel).
  const firstCleaned = cleanReport.find(c => c.kind !== 'forum' && (c.deleted || 0) > 0);
  if (firstCleaned) {
    const res = await call(`mode=archive&channel=${firstCleaned.id}&runId=${runId}`);
    const a = res.json;
    console.log(`## Archive spot-check`);
    console.log(`  #${firstCleaned.name}: archive count=${a.count ?? '?'} vs deleted=${firstCleaned.deleted} (parts=${a.parts ?? '?'})`);
  }
  console.log('');

  // 6. FINAL REPORT
  const totalArchived = cleanReport.reduce((n, c) => n + (c.archived || 0), 0);
  const totalDeleted = cleanReport.reduce((n, c) => n + (c.deleted || 0), 0);
  const totalForumThreads = cleanReport.reduce((n, c) => n + (c.deletedThreads || 0), 0);
  console.log(`## FINAL REPORT`);
  console.log(`  channels scanned (plan)  : ${plan.clean.length + plan.preserve.length + plan.skipped.length}`);
  console.log(`  channels preserved       : ${plan.preserve.length}`);
  console.log(`  channels cleaned         : ${cleanReport.length}`);
  console.log(`  total messages archived  : ${totalArchived}`);
  console.log(`  total messages deleted   : ${totalDeleted}`);
  console.log(`  forum threads deleted    : ${totalForumThreads}`);
  console.log(`  menu channels locked     : ${lockReport.filter(l => l.ok).length}/${lockReport.length}`);
  console.log(`  runId (archive namespace): ${runId}`);

  // Machine-readable tail for the chip report.
  console.log('\n<<<JSON>>>');
  console.log(JSON.stringify({ runId, guildId, plan: {
    clean: plan.clean.length, preserve: plan.preserve.length, menu: plan.menu.length, skipped: plan.skipped.length,
  }, totals: { archived: totalArchived, deleted: totalDeleted, forumThreads: totalForumThreads,
    locked: lockReport.filter(l => l.ok).length }, cleanReport, lockReport }));
})();
