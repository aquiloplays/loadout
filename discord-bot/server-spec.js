// Declarative desired-state spec for the Aquilo Discord server.
// guild-builder.js consumes this and reconciles the actual guild
// against it (idempotent — re-running is safe).
//
// Discord channel TYPES used here:
//   text=0, voice=2, category=4, announcement=5, stage=13, forum=15
//
// Name conventions:
//   categories      ╭— <emoji> <lowercase name> —
//   text channels   <emoji>│<lowercase-kebab-name>   (vertical bar is U+2502)
//   voice channels  <emoji>│<title case>
//
// Permission overwrites are minimal (the bot manages them post-create
// via Discord role IDs that don't exist until the first build).
// Specific overwrites are applied in a second pass after roles exist.

export const SERVER_SPEC = {
  // ── Categories + their channels, in display order ───────────────────
  categories: [
    {
      name: '╭— ‼️ start here —',
      channels: [
        { name: '🫡│rules',         type: 'text' },
        { name: '📣│announcements', type: 'announcement' },
        { name: '🎭│roles',         type: 'text' },
      ],
    },
    {
      name: '╭— 💬 community —',
      channels: [
        { name: '💬│general',         type: 'text' },
        { name: '👋│introductions',   type: 'text' },
        { name: '📸│media-and-clips', type: 'text' },
        { name: '🗳️│suggestions',     type: 'text' },
        { name: '⭐│highlights',      type: 'text', topic: 'Starboard — top-reacted posts land here.' },
        { name: '🔢│counting',        type: 'text', topic: 'Counting game — post the next integer (no doubles).' },
      ],
    },
    {
      name: '╭— 🔴 streams & content —',
      channels: [
        { name: '🔴│live-now', type: 'text', topic: 'Go-live announcements.' },
        { name: '📅│schedule', type: 'text', topic: 'Stream schedule + community-night signups.' },
        { name: '🎬│videos',   type: 'text', topic: 'New YouTube uploads.' },
      ],
    },
    {
      name: '╭— 🛠️ products —',
      channels: [
        { name: '📢│updates',         type: 'text' },
        { name: '🛠️│support',         type: 'forum', topic: 'Open a thread for help with Loadout / Aquilo apps.' },
        { name: '💡│bugs-and-ideas',  type: 'forum', topic: 'Bug reports + feature requests as threads.' },
      ],
    },
    {
      name: '╭— 🎮 games & play —',
      channels: [
        { name: '🎮│game-night',       type: 'text' },
        { name: '🧩│looking-for-game', type: 'text', topic: 'Use /lfg to post sessions.' },
        { name: '🤖│bot-commands',     type: 'text', topic: 'Run /loadout, /hub, /character, etc.' },
        { name: '🃏│games-chat',       type: 'text' },
      ],
    },
    {
      name: '╭— ⛏️ minecraft —',
      channels: [
        { name: '⛏️│smp-info', type: 'text' },
        { name: '💬│smp-chat', type: 'text' },
      ],
    },
    {
      name: '╭— 💎 patrons —',
      channels: [
        { name: '💎│patron-lounge', type: 'text', patronOnly: true },
      ],
    },
    {
      name: '╭— 🔊 voice —',
      channels: [
        { name: '➕│join to create', type: 'voice', tempVcParent: true },
        { name: '🔊│general',        type: 'voice' },
        { name: '🎮│game night',     type: 'voice' },
        { name: '🎤│stage',          type: 'stage' },
        { name: '😴│afk',            type: 'voice', afk: true },
      ],
    },
    {
      name: '╭— 🛡️ staff —',
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
    { name: '🛡️ Moderator', color: 0x5865F2, hoist: true,  mentionable: true },
    { name: '🤖 Bots',      color: 0x99AAB5, hoist: true,  mentionable: false },
    { name: '💎 Patron',    color: 0xF47FFF, hoist: true,  mentionable: true },
    { name: '⭐ Member',    color: 0x57F287, hoist: false, mentionable: false },
    // Self-assign ping roles (low-position, non-hoisted, mentionable)
    { name: 'Stream Pings',  color: 0xEB459E, hoist: false, mentionable: true,  selfAssign: true },
    { name: 'YouTube Pings', color: 0xED4245, hoist: false, mentionable: true,  selfAssign: true },
    { name: 'Event Pings',   color: 0xFEE75C, hoist: false, mentionable: true,  selfAssign: true },
    { name: 'Game Night',    color: 0x57F287, hoist: false, mentionable: true,  selfAssign: true },
    // Activity / progression tie-in roles — granted by the progression
    // system in worker.js when a viewer crosses a level threshold.
    { name: 'Lv 5+',  color: 0x99AAB5, hoist: false, mentionable: false, levelRole: 5  },
    { name: 'Lv 10+', color: 0x99AAB5, hoist: false, mentionable: false, levelRole: 10 },
    { name: 'Lv 25+', color: 0x99AAB5, hoist: false, mentionable: false, levelRole: 25 },
    { name: 'Lv 50+', color: 0x99AAB5, hoist: false, mentionable: false, levelRole: 50 },
  ],
};
