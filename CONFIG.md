# Configuration reference

`settings.json` lives at `%APPDATA%\Loadout\settings.json`. Most settings have a UI in **Settings → \<tab\>**; this page is the canonical reference for what every field does.

Hand-edits take effect after `!loadout reload` (mod) — no Streamer.bot restart needed.

---

## Top level

```jsonc
{
  "SchemaVersion":   1,           // bumped when settings shape changes; auto-migrated
  "SuiteVersion":    "0.1.0",     // matches the DLL's assembly version
  "OnboardingDone":  false,       // wizard auto-opens until true
  "BroadcasterName": ""           // your Twitch login; used in welcomes/recaps/Discord
}
```

---

## Platforms

`Settings → General`

```jsonc
"Platforms": {
  "Twitch":  true,
  "TikTok":  true,
  "YouTube": true,
  "Kick":    true
}
```

Per-platform send/receive enable. Modules check this before posting to or reacting from each platform. **Note:** TikTok via TikFinity is read-only — outbound TikTok posting isn't supported by the platform.

---

## Modules

Every module ships **OFF by default**. Enable individually in `Settings → Modules`.

```jsonc
"Modules": {
  "InfoCommands":       false,    // !uptime / !followage / !so / etc.
  "ContextWelcomes":    false,    // first-time / sub / VIP / mod greetings
  "Alerts":             false,    // follow / sub / cheer / raid / etc. chat alerts
  "TimedMessages":      false,    // rotating chat messages with smart cadence
  "AiShoutouts":        false,    // raid auto-shoutout via Anthropic / OpenAI
  "TikTokHypeTrain":    false,    // synthetic hype train for TikFinity gifts
  "StreamRecap":        false,    // Discord post on streamOffline
  "DiscordLiveStatus":  false,    // go-live / edit / archive embed
  "WebhookInbox":       false,    // HTTP listener for Ko-fi / Throne / etc.
  "HateRaidDetector":   false,    // pattern-based detection (Tier 3)
  "Goals":              false,    // followers/subs/bits/coins toward target
  "Counters":           false,    // !deaths / !wins / custom counters
  "DailyCheckIn":       false,    // overlay on channel-point or !checkin
  "FirstWords":         false,    // celebrate first-ever chat per platform
  "AdBreak":            false,    // chat heads-up + countdown overlay
  "ChatVelocity":       false,    // writes loadout.chatVelocity / .chatTier globals
  "AutoPoll":           false,    // chat poll on category change
  "SubRaidTrain":       false,    // burst detection at 3/6/10/20 subs in 60s
  "VipRotation":        false,    // weekly engagement-based rotation (Tier 3)
  "CcCoinTracker":      false,    // !cccoins leaderboard
  "SubAnniversary":     false,    // 3/6/12/18/24+ month milestones
  "Bolts":              false,    // unified ⚡ wallet
  "Apex":               false     // 👑 top-viewer mode with cross-platform damage
}
```

---

## Bolts

`Settings → Bolts` (UI tab planned; for now edit directly).

```jsonc
"Bolts": {
  "DisplayName": "Bolts",
  "Emoji":       "⚡",

  // Earn rates (raw, before multipliers)
  "PerChatMessage":         1,
  "PerSub":                50,
  "PerGiftSub":            30,    // multiplied by gift count
  "PerRaidBrought":       100,
  "PerCheerBitDivisor":   100,    // 1 bolt per N bits
  "PerCcCoinDivisor":      10,
  "PerDailyCheckIn":      100,
  "SubAnniversaryBonusBase": 100, // total = base × milestone months

  // Multipliers (additive, stack)
  "SubMultiplier":      0.5,      // sub/VIP/mod earn +50%
  "PatreonTier1Bonus":  0.2,
  "PatreonTier2Bonus":  0.5,
  "PatreonTier3Bonus":  1.0,
  "DailyStreakPerDay":  0.1,
  "DailyStreakCap":     1.0,      // streak alone capped at +100%

  // Anti-spam
  "MaxChatEarnsPerMinute":  6,    // per-viewer chat earn cap

  // Spend
  "GiftMinAmount":          10,
  "BoltRainMinTotal":      100,
  "BoltRainMaxRecipients": 100
}
```

---

## Apex

`Settings → Apex` (UI tab planned).

```jsonc
"Apex": {
  "StartingHealth":                 1000,  // HP given to a fresh champion

  // Damage values (per event)
  "DamageSub":                       100,
  "DamageResub":                     100,
  "DamageGiftSub":                    80,  // multiplied by count
  "DamagePerHundredBits":              10,
  "DamagePerTikTokCoin":               1,  // a Rose hits for ~1, a Galaxy for ~1000
  "DamagePerCcCoin":                   1,
  "DamagePerBoltsSpent":               1,
  "DamagePerChannelPointRedemption":  50,
  "DamagePerCheckIn":                 25,
  "DamagePerRaidViewer":               1,

  // Behavior
  "AutoCrownFinisher":      true,         // dethrone → finisher takes the crown
  "SelfImmunity":           true,         // champion can't damage self
  "IncludeBroadcaster":     false,        // streamer can't be Apex by default
  "AnnounceCrownChange":    true,
  "DiscordWebhook":         "",
  "ChatAnnounceDamageThreshold": 200      // chat-mute small hits (overlay still gets all)
}
```

---

## Chat noise

`Settings → Chat Noise` (UI tab planned). The kit is engineered so **Loadout cannot exceed `MaxChatPerMinute` chat messages per minute total** under any combination of settings.

```jsonc
"ChatNoise": {
  "QuietMode":             false,  // master mute (info commands still respond)
  "MaxChatPerMinute":         30,  // global cap, sliding-window enforced

  // Per-area enable (overlays + persistence still work when off)
  "AlertsToChat":          true,
  "WelcomesToChat":        true,
  "InfoCommandsToChat":    true,
  "CountersToChat":        true,
  "BoltsToChat":           true,
  "GoalsToChat":           true,

  // Cooldowns
  "InfoCommandCooldownSec": 30,    // per-command global; mods bypass
  "CounterAckCooldownSec":   5,
  "CounterAckEveryN":        1     // 0 = silent overlay-only, N = every Nth change
}
```

---

## Discord

`Settings → Discord`

```jsonc
"Discord": {
  "LiveStatusWebhook":   "",        // posts on go-live, edits on title/category change
  "RecapWebhook":        "",        // optional separate channel for stream recap
  "GoLiveTemplate":      "🔴 **{broadcaster}** is now live!\n**{title}** — *{game}*\n{url}",
  "AutoEditOnChange":    true,
  "ArchiveOnOffline":    true       // strikethrough + footer instead of delete
}
```

Template placeholders: `{broadcaster}` `{title}` `{game}` `{url}`.

---

## AI shoutouts

`Settings → AI`

```jsonc
"Ai": {
  "Provider":    "anthropic",       // "anthropic" | "openai" | "none"
  "ApiKey":      "",                // BYOK; never sent anywhere except your chosen provider
  "Model":       "claude-haiku-4-5",
  "ShoutoutsEnabled": true,
  "ShoutoutPromptPrefix": "Write a short, hype Twitch shoutout..."
}
```

Anthropic uses the [Messages API](https://docs.claude.com/en/api/messages); OpenAI uses [Chat Completions](https://platform.openai.com/docs/api-reference/chat).

---

## Webhooks (incoming)

`Settings → Webhooks`

```jsonc
"Webhooks": {
  "Enabled":      true,
  "Port":         7474,
  "SharedSecret": "",               // X-Loadout-Secret header or ?secret=
  "Mappings": [
    { "Path": "/kofi",   "SbActionId": "<sb-action-guid>", "Description": "Ko-fi tips" },
    { "Path": "/throne", "SbActionId": "<sb-action-guid>", "Description": "Throne wishlist" }
  ]
}
```

Every hit publishes `webhook.received` on the Aquilo Bus AND optionally fires the configured SB action.

---

## Onboarding gates

`Settings → General` exposes:

- **Update channel** — `stable` or `beta`
- **Re-run onboarding** — opens the wizard fresh

Hand-edit the rest in `settings.json`; reload via `!loadout reload`.

---

## Persisted files

| Path | Contents |
|---|---|
| `%APPDATA%\Loadout\settings.json` | Everything above |
| `%APPDATA%\Loadout\bolts.json` | Wallet balances + streaks |
| `%APPDATA%\Loadout\engagement.json` | Per-viewer activity counters |
| `%APPDATA%\Loadout\quotes.json` | Quote book |
| `%APPDATA%\Loadout\sub-anniversary.json` | Per-viewer sub-start dates + last-fired milestone |
| `%APPDATA%\Loadout\discord-live.json` | Current go-live message ID |
| `%APPDATA%\Loadout\apex.json` | Current Apex state + reign history (last 50) |
| `%APPDATA%\Loadout\identity.json` | Cross-platform identity links |
| `%APPDATA%\Loadout\patreon-state.bin` | DPAPI-encrypted Patreon tokens + tier |
| `%APPDATA%\Loadout\loadout-errors.log` | Append-only error log (auto-rotates at 1 MB) |
| `%APPDATA%\Aquilo\bus-secret.txt` | Per-machine Aquilo Bus shared secret |

See [PRIVACY.md](PRIVACY.md) for what gets sent off-device.
