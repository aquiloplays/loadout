// Declarative desired-state spec for the Aquilo Discord server.
// guild-builder.js consumes this and reconciles the actual guild
// against it (idempotent, re-running is safe).
//
// Discord channel TYPES used here:
//   text=0, voice=2, category=4, announcement=5, stage=13, forum=15
//
// Name conventions:
//   categories      ╭- <emoji> <lowercase name>, //   text channels   <emoji>│<lowercase-kebab-name>   (vertical bar is U+2502)
//   voice channels  <emoji>│<title case>
//
// Permission overwrites are minimal (the bot manages them post-create
// via Discord role IDs that don't exist until the first build).
// Specific overwrites are applied in a second pass after roles exist.

// Staff-lead / "power mod" permission bitfield, shared by every
// server's mod role (Moderator / Vault-Tec Staff). Full moderation
// (kick, ban, timeout, manage messages/nicknames/threads, voice
// mute/deafen/move, view audit log) PLUS server management the team
// needs day-to-day: Manage Channels (create/edit channels) and Manage
// Roles (assign roles below their own). Kept in sync BYTE-FOR-BYTE with
// the ALLOW set in set-mod-permissions.mjs (1402739223766) so neither
// apply path silently reverts the other.
// Still EXCLUDES Administrator / Manage Guild / Manage Webhooks /
// Manage Guild Expressions / View Guild Insights / Mention @everyone:
// staff run the community, they don't own the account.
const MOD_PERMS = (
  (1n << 1n)  | // KICK_MEMBERS
  (1n << 2n)  | // BAN_MEMBERS
  (1n << 4n)  | // MANAGE_CHANNELS
  (1n << 6n)  | // ADD_REACTIONS
  (1n << 7n)  | // VIEW_AUDIT_LOG
  (1n << 10n) | // VIEW_CHANNEL
  (1n << 11n) | // SEND_MESSAGES
  (1n << 13n) | // MANAGE_MESSAGES
  (1n << 14n) | // EMBED_LINKS
  (1n << 15n) | // ATTACH_FILES
  (1n << 16n) | // READ_MESSAGE_HISTORY
  (1n << 18n) | // USE_EXTERNAL_EMOJIS
  (1n << 22n) | // MUTE_MEMBERS
  (1n << 23n) | // DEAFEN_MEMBERS
  (1n << 24n) | // MOVE_MEMBERS
  (1n << 27n) | // MANAGE_NICKNAMES
  (1n << 28n) | // MANAGE_ROLES
  (1n << 31n) | // USE_APPLICATION_COMMANDS
  (1n << 33n) | // MANAGE_EVENTS
  (1n << 34n) | // MANAGE_THREADS
  (1n << 38n) | // SEND_MESSAGES_IN_THREADS
  (1n << 40n)   // MODERATE_MEMBERS (timeout)
).toString();

export const SERVER_SPEC = {
  // ── Categories + their channels, in display order ───────────────────
  categories: [
    {
      name: '╭- ‼️ start here -',
      channels: [
        { name: '🫡│rules',         type: 'text' },
        { name: '📣│announcements', type: 'announcement' },
        { name: '🎭│roles',         type: 'text' },
      ],
    },
    {
      name: '╭- 💬 community -',
      channels: [
        { name: '💬│general',         type: 'text' },
        { name: '👋│introductions',   type: 'text' },
        { name: '📸│media-and-clips', type: 'text' },
        { name: '🗳️│suggestions',     type: 'text' },
        { name: '⭐│highlights',      type: 'text', topic: 'Starboard, top-reacted posts land here.' },
        { name: '🔢│counting',        type: 'text', topic: 'Counting game, post the next integer (no doubles).' },
      ],
    },
    {
      name: '╭- 🔴 streams & content -',
      channels: [
        { name: '🔴│live-now', type: 'text', topic: 'Go-live announcements.' },
        { name: '📅│schedule', type: 'text', topic: 'Stream schedule + community-night signups.' },
        { name: '🎬│videos',   type: 'text', topic: 'New YouTube uploads.' },
      ],
    },
    {
      name: '╭- 🛠️ products -',
      channels: [
        { name: '📢│updates',         type: 'text' },
        { name: '🛠️│support',         type: 'forum', topic: 'Open a thread for help with Loadout / Aquilo apps.' },
        { name: '💡│bugs-and-ideas',  type: 'forum', topic: 'Bug reports + feature requests as threads.' },
      ],
    },
    {
      name: '╭- 🎮 games & play -',
      channels: [
        { name: '🎮│game-night',       type: 'text' },
        { name: '🧩│looking-for-game', type: 'text', topic: 'Use /lfg to post sessions.' },
        { name: '🤖│bot-commands',     type: 'text', topic: 'Run /loadout, /hub, /character, etc.' },
        { name: '🃏│games-chat',       type: 'text' },
      ],
    },
    {
      name: '╭- ⛏️ minecraft -',
      channels: [
        { name: '⛏️│smp-info', type: 'text' },
        { name: '💬│smp-chat', type: 'text' },
      ],
    },
    {
      name: '╭- 💎 patrons -',
      channels: [
        { name: '💎│patron-lounge', type: 'text', patronOnly: true },
      ],
    },
    {
      name: '╭- 🔊 voice -',
      channels: [
        { name: '➕│join to create', type: 'voice', tempVcParent: true },
        { name: '🔊│general',        type: 'voice' },
        { name: '🎮│game night',     type: 'voice' },
        { name: '🎤│stage',          type: 'stage' },
        { name: '😴│afk',            type: 'voice', afk: true },
      ],
    },
    {
      name: '╭- 🛡️ staff -',
      channels: [
        { name: '🧑‍✈️│staff-chat', type: 'text', staffOnly: true },
        { name: '📋│mod-log',     type: 'text', staffOnly: true },
        { name: '⚙️│bot-admin',   type: 'text', staffOnly: true },
      ],
    },
  ],

  // ── Roles in display order (top = highest position) ─────────────────
  // Hex colors converted to integer at apply time.
  roles: [
    { name: '👑 Owner',     color: 0xFFD700, hoist: true,  mentionable: false },
    { name: '🛡️ Moderator', color: 0x5865F2, hoist: true,  mentionable: true, permissions: MOD_PERMS },
    { name: '🤖 Bots',      color: 0x99AAB5, hoist: true,  mentionable: false },
    { name: '💎 Patron',    color: 0xF47FFF, hoist: true,  mentionable: true },
    { name: '⭐ Member',    color: 0x57F287, hoist: false, mentionable: false },
    // Self-assign ping roles (low-position, non-hoisted, mentionable)
    { name: 'Stream Pings',  color: 0xEB459E, hoist: false, mentionable: true,  selfAssign: true },
    { name: 'YouTube Pings', color: 0xED4245, hoist: false, mentionable: true,  selfAssign: true },
    { name: 'Event Pings',   color: 0xFEE75C, hoist: false, mentionable: true,  selfAssign: true },
    { name: 'Game Night',    color: 0x57F287, hoist: false, mentionable: true,  selfAssign: true },
    // Activity / progression tie-in roles, granted by the progression
    // system in worker.js when a viewer crosses a level threshold.
    { name: 'Lv 5+',  color: 0x99AAB5, hoist: false, mentionable: false, levelRole: 5  },
    { name: 'Lv 10+', color: 0x99AAB5, hoist: false, mentionable: false, levelRole: 10 },
    { name: 'Lv 25+', color: 0x99AAB5, hoist: false, mentionable: false, levelRole: 25 },
    { name: 'Lv 50+', color: 0x99AAB5, hoist: false, mentionable: false, levelRole: 50 },
  ],
};

// ── Fallout-themed spec for the dedicated "Aquilo's Vault" server ───────
// (guild 1516302043352928336). Selected via the guild-id branch in
// handleGuildBuild + finalized by applyFalloutPhase2. Fully separate from
// SERVER_SPEC above — the main Aquilo server is unaffected.
//
// Open server (no verify gate). Platform roles exist because Fallout 76 has
// no crossplay, so players self-pick PC / PlayStation / Xbox to find squads.
// The Vault-Tec Staff role uses the same standard mod grant as every
// other server's mod role (defined as MOD_PERMS above).
const FALLOUT_MOD_PERMS = MOD_PERMS;

export const FALLOUT_SPEC = {
  categories: [
    {
      name: '╭- ☢️ start here -',
      channels: [
        { name: '🫡│vault-rules',   type: 'text' },
        { name: '📣│announcements', type: 'text' },
        { name: '🎭│roles',         type: 'text' },
      ],
    },
    {
      name: '╭- 📺 the overseer -',
      channels: [
        { name: '🔴│live-now',       type: 'text', topic: 'Go-live announcements.' },
        { name: '📅│schedule',       type: 'text', topic: 'Stream schedule.' },
        { name: '🎬│clips-and-vods', type: 'text' },
        { name: '💬│stream-chat',    type: 'text' },
      ],
    },
    {
      name: '╭- 🟢 appalachia -',
      channels: [
        { name: '💬│general',             type: 'text' },
        { name: '📰│fo76-news',           type: 'text', topic: 'Fallout 76 news + patch notes.' },
        { name: '🛠️│builds-and-loadouts', type: 'text' },
        { name: '📸│camp-showcase',       type: 'text', topic: 'Show off your C.A.M.P.' },
        { name: '💰│trading-post',        type: 'text', topic: 'Trades + price checks (FED76).' },
      ],
    },
    {
      name: '╭- 🤝 find a squad -',
      channels: [
        { name: '🖥️│lfg-pc',          type: 'text', topic: 'Looking for group — PC (no crossplay).' },
        { name: '🎮│lfg-playstation', type: 'text', topic: 'Looking for group — PlayStation (no crossplay).' },
        { name: '❎│lfg-xbox',         type: 'text', topic: 'Looking for group — Xbox (no crossplay).' },
        { name: '☢️│nuke-runs',        type: 'text', topic: 'Coordinate nuke runs. /nukecodes posts here.' },
        { name: '📅│events',           type: 'text', topic: 'Public event meetups (Eviction Notice, etc.).' },
      ],
    },
    {
      name: '╭- 🎮 vault -',
      channels: [
        { name: '🎮│vault-game',     type: 'text', topic: "Aquilo's Vault game feed + dashboard. /vault" },
        { name: '🤖│vault-commands', type: 'text', topic: 'Bot games: /hack, /vault, /radio, etc.' },
      ],
    },
    {
      name: '╭- 🎲 arcade -',
      channels: [
        { name: '🕹️│arcade',       type: 'text', topic: 'aquilo.gg/play mini-games + casino slash commands.' },
        { name: '🗓️│daily-quests', type: 'text' },
      ],
    },
    {
      name: '╭- 🔊 voice -',
      channels: [
        { name: '➕│join to create',         type: 'voice', tempVcParent: true },
        { name: '🔊│Camp Alpha',             type: 'voice' },
        { name: '🔊│Camp Bravo',             type: 'voice' },
        { name: '🔊│Camp Charlie',           type: 'voice' },
        { name: '😴│AFK at the Whitespring', type: 'voice', afk: true },
      ],
    },
    {
      name: '╭- 🛠️ support -',
      channels: [
        { name: '🛠️│support',     type: 'forum', topic: 'Open a thread for help.' },
        { name: '🗳️│suggestions', type: 'text' },
        { name: '🐛│bug-reports', type: 'text' },
      ],
    },
    {
      name: '╭- 🛡️ staff -',
      channels: [
        { name: '🧑‍✈️│staff-chat', type: 'text', staffOnly: true },
        { name: '📋│mod-log',     type: 'text', staffOnly: true },
        { name: '⚙️│bot-admin',   type: 'text', staffOnly: true },
      ],
    },
  ],
  roles: [
    { name: '👑 Overseer',     color: 0xFFD700, hoist: true,  mentionable: false },
    { name: '🛡️ Vault-Tec Staff', color: 0x5865F2, hoist: true, mentionable: true, permissions: FALLOUT_MOD_PERMS },
    { name: '🤖 Vault-Tec AI', color: 0x99AAB5, hoist: true,  mentionable: false },
    { name: '💎 Patron',       color: 0xF47FFF, hoist: true,  mentionable: true  },
    // Self-assign platform roles (FO76 has no crossplay)
    { name: '🖥️ PC',          color: 0x57F287, hoist: false, mentionable: true, selfAssign: true },
    { name: '🎮 PlayStation', color: 0x2E6BE6, hoist: false, mentionable: true, selfAssign: true },
    { name: '❎ Xbox',        color: 0x107C10, hoist: false, mentionable: true, selfAssign: true },
    // Self-assign ping roles
    { name: '📣 Stream Pings', color: 0xEB459E, hoist: false, mentionable: true, selfAssign: true },
    { name: '☢️ Nuke Runs',    color: 0xFEE75C, hoist: false, mentionable: true, selfAssign: true },
    { name: '🗳️ Event Pings',  color: 0xED4245, hoist: false, mentionable: true, selfAssign: true },
    { name: '🎮 Game Night',   color: 0x57F287, hoist: false, mentionable: true, selfAssign: true },
  ],
};
