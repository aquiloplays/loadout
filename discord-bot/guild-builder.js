// Idempotent Discord-server reconciler.
//
// applyServerSpec(token, guildId, spec, { apply }) reads the guild's
// current state via Discord REST, computes a plan against `spec`, and
// (if apply=true) creates anything missing. NEVER deletes — extras
// are surfaced in the returned `noted_extras` for caller review.
//
// Channel TYPES used:
//   text=0, voice=2, category=4, announcement=5, stage=13, forum=15

const TYPE_NUM = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15 };
const TYPE_NAME = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum' };

// Normalise a channel/category name for matching. Discord auto-
// lowercases text channel names but preserves emoji/box-drawing
// characters. We compare with NFC + lowercase to absorb trivial
// drift; an exact-byte match still wins first.
function normName(s) {
  return String(s || '').normalize('NFC').trim().toLowerCase();
}

async function dapi(token, method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: 'Bot ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { ok: r.ok, status: r.status, body: parsed, raw: text };
}

// Sleep so we respect Discord's rate limits — Discord's global
// budget is generous (~50 req/s), but per-resource buckets are
// tighter. A 250ms gap between channel creates is a safe default.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function applyServerSpec(token, guildId, spec, { apply = false } = {}) {
  const report = {
    ok: true,
    apply,
    guildId,
    categories: { created: [], kept: [], errors: [] },
    channels:   { created: [], kept: [], retyped: [], reparented: [], errors: [] },
    roles:      { created: [], kept: [], errors: [] },
    noted_extras: { channels: [], roles: [] },
  };

  // ── Pull current state ──────────────────────────────────────────────
  const chRes = await dapi(token, 'GET', `/guilds/${guildId}/channels`);
  if (!chRes.ok) {
    return { ...report, ok: false, error: 'fetch-channels-failed', detail: chRes };
  }
  const rolesRes = await dapi(token, 'GET', `/guilds/${guildId}/roles`);
  if (!rolesRes.ok) {
    return { ...report, ok: false, error: 'fetch-roles-failed', detail: rolesRes };
  }
  const currentChannels = chRes.body;     // [{id, name, type, parent_id, position, ...}]
  const currentRoles    = rolesRes.body;  // [{id, name, position, color, hoist, ...}]

  // Index by name for O(1) match.
  const byNameCh = new Map();
  for (const c of currentChannels) byNameCh.set(normName(c.name), c);
  const byNameRole = new Map();
  for (const r of currentRoles) byNameRole.set(normName(r.name), r);

  // ── ROLES (build first so channel permission overwrites can ref them) ─
  // Iterate bottom-up so display order matches the spec (Discord
  // positions are 0=lowest non-@everyone; we just create in spec order
  // and let Discord pile them on top of the @everyone baseline. Re-
  // ordering happens in a final PATCH below).
  const specRolesReversed = [...spec.roles].reverse();
  const roleIdByName = {};
  for (const rspec of specRolesReversed) {
    const existing = byNameRole.get(normName(rspec.name));
    if (existing) {
      roleIdByName[rspec.name] = existing.id;
      report.roles.kept.push({ name: rspec.name, id: existing.id });
      continue;
    }
    if (!apply) {
      report.roles.created.push({ name: rspec.name, dryRun: true });
      continue;
    }
    const create = await dapi(token, 'POST', `/guilds/${guildId}/roles`, {
      name: rspec.name,
      color: rspec.color || 0,
      hoist: !!rspec.hoist,
      mentionable: !!rspec.mentionable,
      permissions: '0',  // baseline — explicit grants happen via channel overwrites
    });
    if (!create.ok) {
      report.roles.errors.push({ name: rspec.name, status: create.status, body: create.raw.slice(0, 200) });
      continue;
    }
    roleIdByName[rspec.name] = create.body.id;
    report.roles.created.push({ name: rspec.name, id: create.body.id });
    await sleep(250);
  }

  // ── CATEGORIES ──────────────────────────────────────────────────────
  const categoryIdByName = {};
  for (const cat of spec.categories) {
    const existing = byNameCh.get(normName(cat.name));
    if (existing && existing.type === TYPE_NUM.category) {
      categoryIdByName[cat.name] = existing.id;
      report.categories.kept.push({ name: cat.name, id: existing.id });
      continue;
    }
    if (existing && existing.type !== TYPE_NUM.category) {
      report.categories.errors.push({
        name: cat.name,
        message: `name exists as type ${TYPE_NAME[existing.type] || existing.type}, not category — leaving alone`,
        existingId: existing.id,
      });
      continue;
    }
    if (!apply) {
      report.categories.created.push({ name: cat.name, dryRun: true });
      continue;
    }
    const create = await dapi(token, 'POST', `/guilds/${guildId}/channels`, {
      name: cat.name,
      type: TYPE_NUM.category,
    });
    if (!create.ok) {
      report.categories.errors.push({ name: cat.name, status: create.status, body: create.raw.slice(0, 200) });
      continue;
    }
    categoryIdByName[cat.name] = create.body.id;
    report.categories.created.push({ name: cat.name, id: create.body.id });
    await sleep(250);
  }

  // ── CHANNELS (under their category) ─────────────────────────────────
  for (const cat of spec.categories) {
    const parentId = categoryIdByName[cat.name];
    for (const ch of cat.channels) {
      const wantType = TYPE_NUM[ch.type];
      if (wantType == null) {
        report.channels.errors.push({ name: ch.name, message: `unknown type ${ch.type}` });
        continue;
      }
      const existing = byNameCh.get(normName(ch.name));
      if (existing) {
        // Already exists. Re-parent if needed (no delete).
        if (existing.parent_id !== parentId && parentId) {
          if (apply) {
            const patch = await dapi(token, 'PATCH', `/channels/${existing.id}`, { parent_id: parentId });
            if (!patch.ok) {
              report.channels.errors.push({ name: ch.name, action: 'reparent', status: patch.status, body: patch.raw.slice(0, 200) });
            } else {
              report.channels.reparented.push({ name: ch.name, id: existing.id, parent_id: parentId });
              await sleep(250);
            }
          } else {
            report.channels.reparented.push({ name: ch.name, id: existing.id, dryRun: true });
          }
        }
        if (existing.type !== wantType) {
          // Discord supports a type swap only between text↔announcement
          // and within voice types. For other mismatches we don't try
          // to recover — leave the existing channel and surface a note.
          const canSwap = (existing.type === 0 && wantType === 5) || (existing.type === 5 && wantType === 0);
          if (canSwap && apply) {
            const patch = await dapi(token, 'PATCH', `/channels/${existing.id}`, { type: wantType });
            if (!patch.ok) {
              report.channels.errors.push({ name: ch.name, action: 'retype', status: patch.status, body: patch.raw.slice(0, 200) });
            } else {
              report.channels.retyped.push({ name: ch.name, id: existing.id, from: TYPE_NAME[existing.type], to: TYPE_NAME[wantType] });
            }
          } else {
            report.channels.errors.push({
              name: ch.name,
              message: `type mismatch: existing=${TYPE_NAME[existing.type] || existing.type}, want=${ch.type} (manual fix needed)`,
              existingId: existing.id,
            });
          }
        }
        report.channels.kept.push({ name: ch.name, id: existing.id });
        continue;
      }
      if (!apply) {
        report.channels.created.push({ name: ch.name, type: ch.type, parent: cat.name, dryRun: true });
        continue;
      }
      const payload = { name: ch.name, type: wantType, parent_id: parentId || undefined };
      if (ch.topic) payload.topic = ch.topic;
      const create = await dapi(token, 'POST', `/guilds/${guildId}/channels`, payload);
      if (!create.ok) {
        report.channels.errors.push({ name: ch.name, status: create.status, body: create.raw.slice(0, 200) });
        continue;
      }
      report.channels.created.push({ name: ch.name, id: create.body.id, type: ch.type, parent: cat.name });
      // Update local index so a duplicate name on the same run won't double-create.
      byNameCh.set(normName(ch.name), create.body);
      await sleep(250);
    }
  }

  // ── Reorder roles to match spec (highest first → highest position) ──
  // We bump our managed roles above @everyone but BELOW the bot's own
  // managed role (which Discord pins at the top). The bot can't move
  // managed roles, so we skip those.
  if (apply) {
    const managedNames = spec.roles
      .map(r => roleIdByName[r.name])
      .filter(Boolean);
    if (managedNames.length) {
      // @everyone is always position 0. Assign our top role the
      // highest position we can claim (= total non-managed-by-discord
      // role count). Walk the spec top-down.
      const total = managedNames.length;
      const positions = spec.roles.map((r, i) => ({
        id: roleIdByName[r.name],
        position: total - i,   // first spec role → highest position
      })).filter(p => p.id);
      const patch = await dapi(token, 'PATCH', `/guilds/${guildId}/roles`, positions);
      if (!patch.ok) {
        report.roles.errors.push({ action: 'reorder', status: patch.status, body: patch.raw.slice(0, 200) });
      }
    }
  }

  // ── Note extras (channels/roles in guild but NOT in spec) ───────────
  const specChannelNames = new Set();
  for (const cat of spec.categories) {
    specChannelNames.add(normName(cat.name));
    for (const ch of cat.channels) specChannelNames.add(normName(ch.name));
  }
  for (const c of currentChannels) {
    if (!specChannelNames.has(normName(c.name))) {
      report.noted_extras.channels.push({
        name: c.name, id: c.id, type: TYPE_NAME[c.type] || c.type, parent_id: c.parent_id || null,
      });
    }
  }
  const specRoleNames = new Set(spec.roles.map(r => normName(r.name)));
  for (const r of currentRoles) {
    if (r.name === '@everyone') continue;
    if (r.managed) continue;
    if (!specRoleNames.has(normName(r.name))) {
      report.noted_extras.roles.push({ name: r.name, id: r.id });
    }
  }

  report.role_ids = roleIdByName;
  report.category_ids = categoryIdByName;
  return report;
}
