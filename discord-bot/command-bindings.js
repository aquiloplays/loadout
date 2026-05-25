// Per-guild "this command can only be used in these channels" allow-list.
//
// Reasoning: once the bot lands in a server with dozens of channels,
// streamers want game/check-in commands to stay in their dedicated
// channels (so #general isn't full of /play and /checkin chatter).
//
// KV layout:
//   guild:cmd-bindings:<g> → { [commandName]: ["<channelId>", ...] }
//                            empty array OR missing entry = no
//                            restriction (command works anywhere).
//
// Enforcement (commands.js dispatcher): before routing a slash
// command, call isCommandAllowedHere(env, guildId, commandName,
// channelId). If false, return an ephemeral "use this in #x" reply
// — never run the handler. Buttons / select-menus / modals are NOT
// gated here (a button on an ephemeral reply doesn't know which
// channel it "belongs" to and gating those would be hostile).

const KEY = (g) => `guild:cmd-bindings:${g}`;

export async function loadBindings(env, guildId) {
  if (!guildId) return {};
  try {
    return (await env.LOADOUT_BOLTS.get(KEY(guildId), { type: 'json' })) || {};
  } catch { return {}; }
}

export async function saveBindings(env, guildId, b) {
  await env.LOADOUT_BOLTS.put(KEY(guildId), JSON.stringify(b || {}));
}

// Predicate: should this command be allowed in this channel?
// Returns { ok: true } or { ok: false, allowed: [channelId, ...] }.
// `allowed: []` means there IS a binding but no channels — treat
// as "command is currently disabled in this guild."
export async function isCommandAllowedHere(env, guildId, commandName, channelId) {
  const b = await loadBindings(env, guildId);
  const entry = b[commandName];
  if (!entry || (Array.isArray(entry) && entry.length === 0 && entry !== null)) {
    // No restriction set → allowed anywhere. (Empty array technically
    // means "no channels assigned, but the command isn't disabled
    // either" — we treat that as unrestricted for the common case of
    // a streamer adding the command name then clearing the channels.
    // To DISABLE a command, just delete it from the bindings map.)
    return { ok: true };
  }
  if (Array.isArray(entry) && entry.includes(String(channelId))) {
    return { ok: true };
  }
  return { ok: false, allowed: Array.isArray(entry) ? entry : [] };
}

// CRUD helpers used by /loadout-setup bind subcommand.
export async function bindCommand(env, guildId, commandName, channelIds) {
  const b = await loadBindings(env, guildId);
  b[commandName] = Array.isArray(channelIds) ? channelIds.map(String) : [String(channelIds)];
  await saveBindings(env, guildId, b);
  return { ok: true, command: commandName, channels: b[commandName] };
}
export async function addCommandChannel(env, guildId, commandName, channelId) {
  const b = await loadBindings(env, guildId);
  const list = Array.isArray(b[commandName]) ? b[commandName].slice() : [];
  if (!list.includes(String(channelId))) list.push(String(channelId));
  b[commandName] = list;
  await saveBindings(env, guildId, b);
  return { ok: true, command: commandName, channels: list };
}
export async function unbindCommand(env, guildId, commandName) {
  const b = await loadBindings(env, guildId);
  delete b[commandName];
  await saveBindings(env, guildId, b);
  return { ok: true, command: commandName };
}

// Build the ephemeral "use this in #x" reply the dispatcher returns
// when a command is run in the wrong channel.
export function wrongChannelReply(commandName, allowed) {
  const head = allowed.length === 1
    ? `Use \`/${commandName}\` in <#${allowed[0]}>.`
    : `Use \`/${commandName}\` in one of: ${allowed.map(c => `<#${c}>`).join(', ')}.`;
  return {
    type: 4,
    data: { content: head, flags: 64 },
  };
}
