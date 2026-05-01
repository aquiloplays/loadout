# Loadout — Fourthwall launch kit

Everything you need to ship Loadout as a product on Fourthwall. Strategy first, then copy, FAQ, integration, and assets to upload.

---

## Strategy

Loadout is **free** with **Patreon-paid tiers** (Plus $6 / Pro $10). Fourthwall is best for one-time digital sales, merch, and lead capture. The two don't compete — they stack.

### The product mix

I'd ship **four Fourthwall products** at launch:

| # | Product | Price | Purpose |
|---|---|---|---|
| 1 | **Loadout — Free Streamer.bot Suite** | $0 (free download) | Lead magnet. Captures email for the newsletter. Drives Patreon. |
| 2 | **Loadout Quick Start: 1-on-1 Setup** | $25 | Done-for-you install + onboarding session. Big-margin service offer. |
| 3 | **Loadout Lifetime Pro** | $59 (one-time) | Alternative to Patreon for users who hate subscriptions. Unlocks all Tier 3 features forever. |
| 4 | **Loadout T-Shirt** | $25 | Merch (your existing Fourthwall shop integration). |

Optional follow-ups after launch:
- Premium overlay theme packs ($5–15)
- Mousepad / sticker pack
- "aquilo.gg Bundle" — Loadout + StreamFusion bundle discount

### Why each one

**#1 Free download** — Fourthwall lets you sell free products. You collect the customer's email at "checkout." That's a permission-based marketing list you can promote new releases / Patreon to. Costs you $0, builds your audience.

**#2 Setup service** — The kit is well-documented but Streamer.bot scares streamers off. A $25 "I'll get you running in 30 minutes" service has near-100% margin and **converts hesitant buyers**. Schedule via Calendly link in the delivery email.

**#3 Lifetime Pro** — Some streamers won't subscribe to Patreon. Offering a one-time price for Tier 3 features captures them. Loadout's `Entitlements.cs` already has the `Bolts`, `BoltsCrossPlatform`, `VipRotationAuto`, `DailyCheckInFlairsPro` etc. gates — just add a "lifetime license" code path that sets the flag without checking Patreon. (Implementation note: see [INTEGRATION.md](INTEGRATION.md).)

**#4 Merch** — already a known good for you. The branded `Loadout.ico` / palette translates to a clean shirt design.

---

## Pricing rationale

| Tier | Monthly cost | Lifetime equivalent (Fourthwall) |
|---|---|---|
| Tier 2 (Plus) | $6/mo | — keep on Patreon, don't sell lifetime |
| Tier 3 (Pro)  | $10/mo | $59 lifetime (~6 months Patreon) |

The $59 lifetime is the sweet spot: less than a year of Patreon, but high enough to feel premium and not undercut subscribers. Subscribers get more value over time (early access, beta channel, Discord perks); lifetime buyers get the product features but not the community perks.

If you want to be even safer, price lifetime at $79.

---

## Product page assets

For each product, Fourthwall asks for:
- Title (≤ 60 char)
- Tagline / subtitle (≤ 120 char)
- Long description (markdown)
- Hero image (1200×800 recommended)
- Gallery images (at least 3)
- Variants (size for shirts, "delivery method" for digital)
- Inventory (∞ for digital)
- Refund policy

All copy is in [`copy.md`](copy.md). Hero image specs in [`assets-spec.md`](assets-spec.md). FAQ in [`faq.md`](faq.md).

---

## Delivery mechanism

Three options for the digital products:

### Option A — Public download link in delivery email *(recommended for #1 free download)*

Fourthwall's "digital product" feature lets you attach a file. We won't attach the DLL directly (it'd go stale every release). Instead, ship a tiny PDF / TXT file containing the GitHub release link + quick-start. The user always gets the latest from GitHub.

Sample delivery file (`Loadout-Download.txt`):

```
LOADOUT - Quick Start

Thanks for getting Loadout! Here's where to grab the latest build:

→ https://github.com/aquiloplays/loadout/releases/latest

Install in 5 minutes:
1. Download Loadout.dll + loadout-import.sb.txt
2. Drop Loadout.dll into <Streamerbot>/data/Loadout/
3. In Streamer.bot, click Import (top-right), paste the import string
4. Right-click 'Loadout: Boot' and Run Now
5. Onboarding wizard opens. Pick what you want enabled. Done.

Full guide: https://github.com/aquiloplays/loadout/blob/main/INSTALL.md
Settings reference: https://github.com/aquiloplays/loadout/blob/main/CONFIG.md
Issues: https://github.com/aquiloplays/loadout/issues

Want more? Patreon supporters get Plus / Pro features:
→ https://patreon.com/aquiloplays

Thanks for supporting indie streaming tools 💜
- aquilo_plays
```

### Option B — License key + lifetime Pro server-side check *(for #3)*

Fourthwall webhook → aquilo-bot → records the customer's email + a generated license key in a Cloudflare Workers KV. Loadout's `LicenseClient.cs` (to be added — sketched in [INTEGRATION.md](INTEGRATION.md)) calls the worker on first run with the user's license key, gets back a tier, and `Entitlements.IsUnlocked` honors it the same as Patreon.

### Option C — Calendly link in delivery email *(for #2 setup service)*

Just a one-pager: "Thanks for buying. Schedule your 30-min session here: https://calendly.com/...". Fourthwall handles the receipt; Calendly handles the booking.

---

## Webhook integration

Fourthwall fires webhooks on `ORDER_PAID`, `ORDER_REFUNDED`, etc. Point them at the new aquilo-bot service:

```
Webhook URL:  https://your-railway-host.up.railway.app/fourthwall
Header:       X-Aquilo-Bot-Secret: <your AQUILO_BOT_SECRET>
```

The bot will post each order to your `FOURTHWALL_SALES_CHANNEL_ID` Discord channel and (with the lifetime-license addition) also write the license to KV.

Full integration spec: [INTEGRATION.md](INTEGRATION.md).

---

## Launch checklist

- [ ] Connect Fourthwall to your Discord (existing)
- [ ] Create the four products above using copy from [`copy.md`](copy.md)
- [ ] Upload hero + gallery images per [`assets-spec.md`](assets-spec.md)
- [ ] Add the free download with `Loadout-Download.txt` attached
- [ ] (For #3) Implement the license-key path in Loadout — see [INTEGRATION.md](INTEGRATION.md)
- [ ] Configure Fourthwall webhook → aquilo-bot
- [ ] Set `FOURTHWALL_SALES_CHANNEL_ID` env on Railway
- [ ] Deploy aquilo-bot on Railway (see `~/Desktop/aquilo-bot/README.md`)
- [ ] Soft-launch: post Loadout v0.1.0 release notes, link Fourthwall in the Discord embed footer
- [ ] After 1 week: announce on TikTok / Twitter, link Fourthwall directly

---

## Refund policy (for Fourthwall product page)

> Digital downloads are non-refundable once delivered. The free download is, well, free — no refund needed.
>
> The 1-on-1 Setup service is refundable up to 24 hours before your scheduled session. Cancellations after that point are non-refundable but rescheduling is always free.
>
> Loadout Lifetime Pro: 14-day refund window. If you can't get it working with us in that time, full refund. After that, the license is permanent — no refunds, but no expiration either.

Add this verbatim to each product's "Refund Policy" field.
