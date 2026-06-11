// Driver for the one-shot visibility gate: non-Members see ONLY #rules.
//
// Talks to the deployed worker's /admin/discord/cleanup/<guild>/<token>
// route (same KV token gate as discord-cleanup-run.mjs), one channel per
// call so each request stays under the subrequest budget. Re-runnable /
// idempotent: a second run reports every overwrite row as skipped.
//
// What it does:
//   1. gate-plan    classify every channel (keep / target / already hidden)
//                   + bot-sight check (admin bypass or explicit overwrite)
//   2. gate keep=1  @everyone VIEW+HISTORY allow on the keep channel
//   3. gate         per target: @everyone VIEW deny + Member VIEW allow
//                   (+ mod/owner roles, + bot user rows when a bot lacks admin)
//   4. gate-verify  recompute role-less visibility; leaks must be []
//
// Env:
//   CLEANUP_TOKEN   required, matches KV bootstrap-discord-cleanup-token
//   GUILD_ID        default 1504103035951906883 (Aquilo guild)
//   WORKER_BASE     default https://loadout-discord.aquiloplays.workers.dev
//   KEEP_CHANNEL    default 1504127968883249273 (#rules, has the Verify button)
//   MEMBER_ROLE     default 1507973873965076490 (Member)
//   EXTRA_ROLES     CSV, default mod+owner role ids from guild:cfg
//   DRY_RUN         '1' -> plan + print only, no writes

const token = process.env.CLEANUP_TOKEN;
if (!token) { console.error('CLEANUP_TOKEN required'); process.exit(1); }
const guildId = process.env.GUILD_ID || '1504103035951906883';
const base = (process.env.WORKER_BASE || 'https://loadout-discord.aquiloplays.workers.dev').replace(/\/$/, '');
const keepChannel = process.env.KEEP_CHANNEL || '1504127968883249273';
const memberRole = process.env.MEMBER_ROLE || '1507973873965076490';
const extraRoles = (process.env.EXTRA_ROLES || '1507973879442964660,1507973881762287636')
  .split(',').map(s => s.trim()).filter(Boolean);
const dryRun = process.env.DRY_RUN === '1';
const root = `${base}/admin/discord/cleanup/${guildId}/${token}`;

const CH_TYPE = { 0: 'text', 2: 'voice', 4: 'CATEGORY', 5: 'announce', 13: 'stage', 15: 'forum', 16: 'media' };

async function call(qs) {
  const r = await fetch(`${root}?${qs}`, { method: 'POST' });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { ok: false, raw: text.slice(0, 300) }; }
  return { status: r.status, json };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`# Discord visibility gate`);
  console.log(`  guild=${guildId} keep=${keepChannel} member=${memberRole} dryRun=${dryRun}`);
  console.log(`  worker=${base}\n`);

  // 1. PLAN
  const { status: pStatus, json: plan } = await call(
    `mode=gate-plan&keep=${keepChannel}&member=${memberRole}`);
  if (!plan.ok) { console.error('PLAN failed:', pStatus, JSON.stringify(plan).slice(0, 400)); process.exit(1); }

  console.log(`## Plan`);
  console.log(`  @everyone has guild-level VIEW : ${plan.everyoneHasGuildView}`);
  console.log(`  @everyone is admin (!!)        : ${plan.everyoneIsAdmin}`);
  console.log(`  member role                    : ${plan.memberRole ? `${plan.memberRole.name} (${plan.memberRole.id})` : 'NOT FOUND'}`);
  for (const b of plan.bots) {
    console.log(`  bot ${b.id}: ${b.present ? `present admin=${b.admin}` : 'not in guild'}`);
  }
  if (!plan.keep) { console.error('\nKEEP CHANNEL NOT FOUND in guild, aborting.'); process.exit(1); }
  console.log(`  keep channel : #${plan.keep.name} (${plan.keep.id}) visibleNow=${plan.keep.visibleNow}`);
  console.log(`\n  Gate targets (currently visible to role-less members): ${plan.targets.length}`);
  for (const c of plan.targets) console.log(`    - [${CH_TYPE[c.type] || c.type}] ${c.name} (${c.id})`);
  console.log(`  Already hidden (untouched): ${plan.alreadyHidden.length}`);
  for (const c of plan.alreadyHidden) console.log(`    - [${CH_TYPE[c.type] || c.type}] ${c.name} (${c.id})`);

  if (!plan.memberRole) { console.error('\nMember role not found, aborting.'); process.exit(1); }
  if (plan.everyoneIsAdmin) { console.error('\n@everyone has ADMINISTRATOR, overwrites would not stick. Aborting.'); process.exit(1); }

  // Bots without admin need explicit per-channel user rows or they go
  // blind the moment @everyone VIEW is denied (role-level guild perms
  // are stripped by the @everyone deny in Discord's algorithm).
  const extraUsers = plan.bots.filter(b => b.present && !b.admin).map(b => b.id);
  if (extraUsers.length) console.log(`\n  Non-admin bots -> per-channel allow rows: ${extraUsers.join(', ')}`);

  if (dryRun) { console.log('\nDRY_RUN=1 -> stopping before any write.'); return; }

  // 2. KEEP channel first (so there is never a moment with zero
  // public channels if the run dies midway).
  console.log(`\n## Apply`);
  {
    const { json: j } = await call(`mode=gate&channel=${keepChannel}&keep=1`);
    console.log(`  KEEP #${j.name || keepChannel}: ${j.ok ? 'OK' : 'FAILED'} applied=[${(j.applied || []).join(', ')}] skipped=[${(j.skipped || []).join(', ')}]${j.errors?.length ? ' errors=' + JSON.stringify(j.errors) : ''}`);
    if (!j.ok) { console.error('Keep-channel write failed, aborting before gating anything.'); process.exit(1); }
  }

  // 3. GATE each target.
  const qsBase = new URLSearchParams({ mode: 'gate', member: memberRole });
  if (extraRoles.length) qsBase.set('extraRoles', extraRoles.join(','));
  if (extraUsers.length) qsBase.set('extraUsers', extraUsers.join(','));
  const results = [];
  for (const c of plan.targets) {
    const qs = new URLSearchParams(qsBase); qs.set('channel', c.id);
    let attempt = 0, res;
    while (attempt < 5) {
      res = await call(qs.toString());
      if (res.json.ok) break;
      attempt++;
      console.log(`    retry ${attempt} for ${c.name} (${res.status})`);
      await sleep(1500);
    }
    const j = res.json;
    console.log(`  [${CH_TYPE[c.type] || c.type}] ${c.name}: ${j.ok ? 'GATED' : 'FAILED'} applied=${(j.applied || []).length} skipped=${(j.skipped || []).length}${j.errors?.length ? ' errors=' + JSON.stringify(j.errors) : ''}`);
    results.push({ id: c.id, name: c.name, ...j });
    await sleep(300);
  }

  // 4. VERIFY
  console.log(`\n## Verify`);
  const { json: v } = await call(`mode=gate-verify&keep=${keepChannel}`);
  console.log(`  keep channel visible to non-members : ${v.keepVisible}`);
  console.log(`  leaks (visible but should be hidden): ${(v.leaks || []).length}`);
  for (const l of v.leaks || []) console.log(`    ! [${CH_TYPE[l.type] || l.type}] ${l.name} (${l.id})`);
  console.log(`  VERDICT: ${v.ok ? 'PASS, non-members see exactly one channel' : 'FAIL'}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n## FINAL REPORT`);
  console.log(`  gated   : ${results.filter(r => r.ok).length}/${plan.targets.length}`);
  console.log(`  failed  : ${failed.length}${failed.length ? ' -> ' + failed.map(f => f.name).join(', ') : ''}`);

  console.log('\n<<<JSON>>>');
  console.log(JSON.stringify({ guildId, keepChannel, verify: v,
    gated: results.filter(r => r.ok).length, failed: failed.map(f => ({ id: f.id, name: f.name })) }));
  if (!v.ok || failed.length) process.exit(1);
})();
