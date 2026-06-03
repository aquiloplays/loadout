# Patreon gift memberships, feature spec

**Status:** research + decision pending. **Do not build yet.** Clay picks Path A or Path B.

**Author:** Claude · 2026-05-28
**Source asks:** Clay queue 2026-05-28 item 3

---

## TL;DR

Patreon's **native fan-to-fan gifting is already available** on every creator account that uses subscription billing. Clay can enable / verify it on his page from the **Promotions tab → Gifted by others → Settings icon → "Enable gifts by fans"**. **Path A is the cleanest path** and should be the default recommendation unless Path B unlocks something specific Path A can't.

The only real friction: **gifts do not trigger pledge webhooks**, so aquilo can't react in real-time when a gift kicks in or expires. Workable with a periodic Patreon member-list poll (which the existing patreon-tier writer already does), but worth knowing.

---

## Path A, Patreon native fan-to-fan gifting

### How it works
1. **Sender** logs into Patreon, visits Clay's page, picks **gift duration (1-12 months)** + any non-limited tier, pays at the per-tier rate × months.
2. Sender gets a **gift link** by email (link expires in 90 days if unredeemed).
3. **Sender shares the gift link** with the recipient via any out-of-band channel (Discord DM, text, etc.).
4. **Recipient** opens the link on **desktop or mobile web** (not the Patreon mobile app), creates / logs into a Patreon account, redeems.
5. Recipient appears as an Active patron at that tier for the gift period. Patreon does NOT auto-charge them after the period ends, they're prompted 3 days before expiry to add payment to convert to paid.

### Aquilo integration
- **No build required.** Aquilo already gates on `patreon:tier:<userId>` (per [`patreon-link.js`](discord-bot/patreon-link.js)).
- Whoever writes `patreon:tier:<userId>` (the aquilo-site OAuth callback walks the member list) will see the gifted recipient as a normal patron during the gift window and write the tier record.
- **Detection latency** = the poll cadence of the existing patreon-tier writer (unknown, site-side).
- **Expiry latency** = same. When the gift period ends and the recipient doesn't convert, they drop off Patreon's member list and the next poll removes their tier record. The existing [`userHasPaidPatreon`](discord-bot/patreon-link.js) gate (which the new [Item 12 MC whitelist](discord-bot/mc-whitelist.js) depends on) flips to false on the next sync.

### What Clay needs to do
1. **Verify gifting is enabled:** Patreon → Creator dashboard → Promotions → "Gifted by others" → Settings icon → toggle "Enable gifts by fans" ON if not already.
2. **Surface the gift flow** to viewers via a Discord embed or aquilo.gg page: "Gift a friend N months of Aquilo Supporter access, opens Patreon, costs $X/mo × N." Link to Clay's Patreon page.
3. **(Optional)** Add a Discord/aquilo notification when a gift lands. Since Patreon doesn't webhook on gifts, the only way is to detect a *new* Active patron in the next member-list poll and DM them, that's already approximately what aquilo does for new patron grants.

### Caveats / known limitations of Path A
| Issue | Impact | Mitigation |
|---|---|---|
| No webhook on gift redemption | Aquilo finds out at next member-poll, not in real-time. | Acceptable for non-time-critical features. Poll cadence is already in place. |
| No webhook on gift expiry | Same, drop-off detected at next poll. | Same. The MC whitelist sweep already handles paid→unpaid transitions on a daily cron. |
| Gift link must be sent out-of-band | Sender has to share the link to recipient via Discord / text / etc. | Acceptable. Patreon emails the link to the sender, they paste it. |
| Mobile-app redemption not supported | Recipient must open the link on web. | Minor friction; document on the gift-prompt embed. |
| API v2 exposes gifted memberships in the member list | We can DETECT a gifted patron is "gifted" vs "paid" if we want to badge them differently. | Optional, track in the existing `patreon:tier` record's metadata. |

---

## Path B, aquilo-side equivalent (custom "Sponsor a Friend")

Only build this if Path A is ruled out for a specific reason (e.g. Clay wants gifting to NOT require recipients to have a Patreon account, or wants to bypass Patreon's per-tier pricing for an aquilo-internal "supporter" pass).

### Architecture
1. **Sender** pays Clay through:
   - A Patreon one-time "Sponsor" tier (if Clay creates one), OR
   - **Stripe Checkout** integrated into aquilo.gg (NEW infra)
2. **Sender specifies recipient** at checkout: recipient's aquilo Discord ID (the same one used for the wallet).
3. On payment success, aquilo writes `patreon-gifted:<recipientDiscordId>` → `{expires_at, gifted_by, tier, source}`.
4. Existing [`userHasPatreon`](discord-bot/patreon-link.js) extends to check the `patreon-gifted` key alongside the real signals (a fourth signal).
5. Existing [`userHasPaidPatreon`](discord-bot/patreon-link.js) likewise extends, `paid: true` returns when the gift is active.
6. **Recipient gets a DM**: "🎁 @userA gifted you N months of Aquilo Supporter. Here's what unlocks: [list of paid-only perks, including MC whitelist]."
7. **Profile shows the gift** + expiry date.
8. **Daily cron** sweeps expired gifts, removes the flag, sends a "your gift just expired" DM.

### Build effort
- New Stripe integration (a few hundred lines of worker code + Stripe dashboard config + webhook secret + dashboard for sender to specify recipient). Significant.
- OR new Patreon "Sponsor" tier + manual reconciliation. Lighter but error-prone.
- New KV layout, new helper, new DM template, new cron sweep, new dashboard page.

### Why this is heavier than it looks
- Stripe brings in PCI scope concerns even with Checkout (Clay's worker becomes part of the flow once we handle webhook secrets).
- Patreon one-time pledges are awkward, Patreon's billing model assumes recurring memberships; one-shots are second-class.
- Reconciling refunds / chargebacks requires us to invalidate gift flags retroactively.

### When Path B IS worth it
- Clay wants gifting to work for users who don't have a Patreon account at all.
- Clay wants pricing different from his Patreon tier prices (e.g. flat $5 "supporter month" regardless of tier).
- Clay wants gift-only perks that don't map to a Patreon tier (an aquilo-exclusive "Sponsored Supporter" tier that real patrons can't get).

None of these are stated requirements right now.

---

## Recommendation

**Go with Path A.** Patreon's native gift system is already built, already integrated with Clay's existing payment flow, and aquilo's existing `patreon:tier`-watching infrastructure picks up gifted patrons automatically. The webhook gap is a minor cosmetic concern (no real-time "you got gifted!" DM) and can be filled by detecting new-member additions in the existing patreon-tier writer's poll.

### Action items if Clay picks A
1. Clay → verify "Enable gifts by fans" toggle is ON in Patreon Promotions tab.
2. Clay → confirm the existing patreon-tier writer's poll cadence is acceptable for gift-detection latency (probably already ≤24h, which is fine).
3. Loadout worker → add a small embed surface in the games-menu / hub: "Gift Aquilo Supporter access" with a `[link button → Clay's Patreon page]`.
4. (Optional) Loadout worker → in the patreon-tier writer's next-poll diff, detect first-time patrons + DM with a "Welcome, here's what unlocks" message. This already exists or is close to existing for paid patrons; extend to cover the gifted variant.

### Action items if Clay picks B (NOT recommended without a strong reason)
- Significant build: spawn as a separate chip targeting `discord-bot/` + the aquilo-site checkout flow.
- Need: Stripe account, dashboard config, webhook secret, recipient-resolution UX, expiry cron, DM templates, profile badge, refund-handling.

---

## Sources

- [How to gift memberships to other fans, Patreon Help](https://support.patreon.com/hc/en-us/articles/31344987943949-How-to-gift-memberships-to-other-fans)
- [FAQ: Fan gifting, Patreon Help](https://support.patreon.com/hc/en-us/articles/31345081474189-FAQ-Fan-gifting)
- [Redeeming a gift from a creator, Patreon Help](https://support.patreon.com/hc/en-us/articles/31345076251917-Redeeming-a-gift-from-a-creator)
- [Gifted pledges neither trigger a webhook nor are they exposed properly in the API, Patreon Developers Forum](https://www.patreondevelopers.com/t/gifted-pledges-neither-trigger-a-webhook-nor-are-they-exposed-properly-in-the-api/9808)
