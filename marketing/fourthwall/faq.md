# Loadout FAQ — Fourthwall product page

Add this to the FAQ section of every Loadout product on Fourthwall. Trim to fit if a product has its own product-specific section.

---

## General

### What is Loadout?

A complete Streamer.bot suite. One import string drops 24 modules onto your bot — info commands, multi-platform alerts, smart timed messages, AI-personalized shoutouts, hate-raid detection, an Apex top-viewer mode, a unified Bolts wallet, the whole thing. Configured entirely from a real Windows settings UI.

### Is this a Streamer.bot replacement?

No — Loadout runs *inside* Streamer.bot. You still need SB. Loadout adds 24 modules + a settings UI + 5 OBS overlays on top of it.

### What platforms does it support?

Twitch, YouTube, Kick, and TikTok (via TikFinity). Every module that posts to chat is platform-aware and can mirror across all four with one setting.

### Is it really free?

Yes. The core kit is free. Patreon Tier 2 ($6/mo) and Tier 3 ($10/mo) unlock premium features (multi-platform mirroring, AI shoutouts, hate-raid detector, etc.) but the free tier is fully functional. AI shoutouts are also free if you bring your own API key.

### Why both free + Patreon?

The free tier handles 95% of streamers. Patreon supports the development of features that cost real money to run (AI shoutouts use API credits) and rewards people who want the premium polish.

### Does it work alongside StreamFusion / Throne / SB-Plus / Pulsoid / Crowd Control?

Yes. Loadout is additive — it doesn't replace your existing SB actions. It adds new ones. The Crowd Control coin tracker actively integrates with CC events; the Aquilo Bus lets StreamFusion subscribe to Loadout events live.

---

## Install / setup

### How long does install take?

5 minutes if you've used Streamer.bot before. 10 if you haven't. The onboarding wizard walks you through everything.

### Do I have to edit my Streamer.bot actions?

No. Zero References-tab editing. The 9 trampoline actions in the import bundle load Loadout's DLL via reflection at runtime. You paste the import string, run "Loadout: Boot" once, and the wizard takes over.

### Where does it install files?

- `<Streamerbot>/data/Loadout/Loadout.dll` — the DLL
- `%APPDATA%\Loadout\` — settings and persisted data
- `%APPDATA%\Aquilo\bus-secret.txt` — local Aquilo Bus shared secret

That's it. Loadout doesn't install anything outside those folders.

### Does it run on Mac / Linux?

Streamer.bot is Windows-only, so Loadout is too.

### Can I use it on my streaming PC AND my gaming PC?

Loadout runs on whichever PC has Streamer.bot. Most setups have SB on the streaming PC; install Loadout there.

---

## Features

### What's the Apex feature?

A top-viewer mode where one viewer holds "the Apex" with an HP pool. Every spend event from anyone else (subs, gifts, cheers, channel-point redemptions, CC coin spends, **TikTok gifts**, daily check-ins, raids) chips away at it. When HP hits 0, the finisher takes the crown. Cross-platform — a TikTok viewer who's `!link`'d their Twitch handle holds one Apex slot, not two.

### What are Bolts?

Loadout's unified points wallet. Earn from chat (1), subs (50), gifts (30 each), raids (100), bits (1 per 100), TikTok coins, CC coins, and daily check-ins. Multipliers stack: sub +50%, Patreon Tier 3 +100%, daily streak up to +100%. Spend with `!gift @user N` and `!boltrain N`. Cross-platform via the `!link` command.

### Does AI shoutouts use my API key or yours?

Free tier: bring your own (Anthropic Claude or OpenAI). Tier 3 Patreon ($10/mo) or Lifetime Pro ($59 one-time): bundled key.

### Will it spam my chat?

No. ChatGate caps Loadout's combined chat output at 30 messages/minute total. Per-area mute (alerts, welcomes, info commands, counters, bolts, goals) and a master "Quiet Mode" toggle (`!loadout quiet`) silence ambient chat without disabling features — overlays still update.

### What overlays are included?

5 OBS browser source URLs, all on aquilo.gg:
- `aquilo.gg/overlays/check-in` — Daily Check-In with avatar, sub flair, Patreon flair, rotating stats
- `aquilo.gg/overlays/counters` — `!deaths`, `!wins`, custom counters
- `aquilo.gg/overlays/goals` — follower / sub / bit / coin progress bars
- `aquilo.gg/overlays/bolts` — unified leaderboard + earn toasts + bolt rain + streak banner
- `aquilo.gg/overlays/apex` — Apex card with avatar, animated HP bar, reign timer, damage feed

---

## Privacy / data

### What data does Loadout collect?

Almost nothing leaves your PC. We do not run telemetry, analytics, or crash reports. The two exceptions are:

1. **Patreon sign-in** (only if you click Connect Patreon) — the standard Patreon OAuth flow.
2. **AI shoutouts** (only if you enable them and provide an API key) — your prompt goes directly from your PC to Anthropic / OpenAI.

Full details: [PRIVACY.md](https://github.com/aquiloplays/loadout/blob/main/PRIVACY.md).

### Where does my Patreon token live?

DPAPI-encrypted on your PC at `%APPDATA%\Loadout\patreon-state.bin`. It can only be decrypted by the same Windows account on the same PC.

### Do you sell my email?

No. The Fourthwall checkout email goes to our newsletter list (with your consent at checkout). We use it for product updates only — never sold, never given to third parties. Unsubscribe in any email.

---

## Lifetime Pro license

### How does the Lifetime Pro license work?

After purchase you get a license key by email. Paste it into Loadout's Settings → Patreon tab → License key field. Loadout verifies it once with our license server, then unlocks all Tier 3 features on that machine.

### Can I install it on multiple PCs?

Yes — your streaming PC and your gaming PC if you stream from both. The license isn't hard-locked per-machine.

### What if I lose the key?

Email aquilo.gg with your Fourthwall order number. We'll resend.

### What happens if Loadout shuts down?

The license is permanent — the features keep working as long as the DLL runs. We commit to maintaining stable-tier compatibility for the lifetime of the product. If we ever sunset Loadout entirely we'll provide one final no-license-check build.

### Is Lifetime Pro the same as Patreon Tier 3?

Same features, yes. Patreon also includes community perks (Discord roles, early access posts, behind-the-scenes, voting on roadmap). Lifetime is feature-only.

### Does Lifetime renew?

No. One payment. Yours forever.

---

## Refunds

### Free download

It's free. No refund needed. Just stop using it.

### Setup service ($25)

24+ hours before your booked slot: full refund. Within 24 hours: free rescheduling, no refund.

### Lifetime Pro ($59)

14-day money-back guarantee. If you can't get it working with us in 14 days, full refund. After that, the license is permanent — no refunds, no expiration.

### T-shirt ($25)

Standard merch policy: 30-day return for unworn items. Defects covered for life.

---

## Support

### How do I get help?

- **Bugs** → file a [GitHub issue](https://github.com/aquiloplays/loadout/issues) with the bug report template
- **Feature ideas** → also a GitHub issue (feature template)
- **Setup help** → either the free [INSTALL.md](https://github.com/aquiloplays/loadout/blob/main/INSTALL.md) walkthrough, the $25 1-on-1 setup product, or our Discord
- **Account / payment** → reply to your Fourthwall order email

### Where's the Discord?

Linked from [aquilo.gg](https://aquilo.gg).
