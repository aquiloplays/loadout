# Fourthwall integration spec

How Fourthwall, the aquilo-bot, and Loadout fit together. Covers the Discord notification path (works today) and the Lifetime Pro license path (requires Loadout v0.2 changes outlined below).

---

## Path 1 — Order notifications (works today)

Fourthwall webhook → aquilo-bot → Discord embed. Already implemented in `aquilo-bot/src/server.js`.

### Fourthwall config

1. Fourthwall dashboard → **Apps** → **Webhooks** → **+ New webhook**
2. **URL:** `https://your-railway-host.up.railway.app/fourthwall`
3. **Custom headers:**
   - `X-Aquilo-Bot-Secret: <your AQUILO_BOT_SECRET>`
4. **Events to subscribe:** `ORDER_PAID`, `ORDER_REFUNDED`, `ORDER_CANCELED`
5. Save.

### Bot config

On Railway, set:
```
FOURTHWALL_SALES_CHANNEL_ID=<your private #sales channel ID>
```

Every order fires a Discord embed in that channel with the JSON payload. Useful for live tracking + customer welcome ping.

---

## Path 2 — Lifetime Pro license (requires Loadout v0.2)

This is the bigger lift. Three components: a Cloudflare Workers KV store, a Loadout-side `LicenseClient.cs`, and a Settings UI field for the key.

### How it flows

```
1. Customer buys "Loadout Lifetime Pro" on Fourthwall
                ↓ ORDER_PAID webhook
2. Fourthwall → aquilo-bot /fourthwall route
                ↓ generates a license key (e.g. base64url of 24 random bytes)
                ↓ POSTs to streamfusion-patreon-proxy worker /api/loadout-license/issue
                ↓ worker writes { email, productId, key, tier: "tier3" } to KV
                ↓ posts a message to Discord #sales
                ↓ sends Fourthwall a "deliver this license key" replyback
3. Fourthwall delivery email contains the license key
4. Customer pastes key into Loadout Settings → Patreon → License key field
                ↓ Loadout LicenseClient.cs calls /api/loadout-license/lookup?key=...
                ↓ worker returns { tier: "tier3", email: "..." }
                ↓ Loadout caches result, sets local entitlement to tier3
5. Entitlements.IsUnlocked() returns true for all Tier 3 features
```

### Worker changes (extend `loadout-link-worker.js`)

Add three routes alongside the existing `/api/link/*`:

```js
// New routes:
//   POST /api/loadout-license/issue   (auth: AQUILO_BOT_SECRET)
//   GET  /api/loadout-license/lookup?key=<key>   (anonymous, rate-limited)
//   POST /api/loadout-license/revoke  (auth: AQUILO_BOT_SECRET)

async function handleIssueLicense(req, env) {
  const { email, orderId, productId } = await req.json();
  const key = randomToken();          // 24 random bytes, base64url
  await env.LINK_KV.put('license:' + key, JSON.stringify({
    email, orderId, productId,
    tier: 'tier3',
    issuedUtc: new Date().toISOString()
  }));
  return jsonResponse({ key });
}

async function handleLookupLicense(url, env) {
  const key = url.searchParams.get('key');
  if (!key) return jsonResponse({ tier: null });
  const raw = await env.LINK_KV.get('license:' + key);
  if (!raw) return jsonResponse({ tier: null });
  const lic = JSON.parse(raw);
  if (lic.revoked) return jsonResponse({ tier: null, revoked: true });
  return jsonResponse({ tier: lic.tier });
}

async function handleRevokeLicense(req, env) {
  const { key, reason } = await req.json();
  const raw = await env.LINK_KV.get('license:' + key);
  if (!raw) return jsonResponse({ ok: false, error: 'unknown' }, { status: 404 });
  const lic = JSON.parse(raw);
  lic.revoked = true;
  lic.revokedReason = reason || '';
  lic.revokedUtc = new Date().toISOString();
  await env.LINK_KV.put('license:' + key, JSON.stringify(lic));
  return jsonResponse({ ok: true });
}
```

### aquilo-bot changes

Extend `src/server.js` `/fourthwall` handler:

```js
app.post('/fourthwall', writeLimiter, requireSecret, async (req, res) => {
  const event = req.body || {};
  if (event.type === 'ORDER_PAID' && event.data?.product?.id === FOURTHWALL_LIFETIME_PRO_ID) {
    // 1. Mint a license via the worker
    const issueResp = await fetch(WORKER_BASE + '/api/loadout-license/issue', {
      method: 'POST',
      headers: {
        'X-Aquilo-Bot-Secret': process.env.AQUILO_BOT_SECRET,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: event.data.customer?.email,
        orderId: event.data.id,
        productId: event.data.product.id
      })
    });
    const { key } = await issueResp.json();

    // 2. Tell Fourthwall to deliver this key in the order email
    //    (Fourthwall has a "fulfillment" API for this — see their docs)
    await fetch(`https://api.fourthwall.com/v1/orders/${event.data.id}/fulfill`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.FOURTHWALL_API_KEY },
      body: JSON.stringify({
        delivery: {
          subject: 'Your Loadout Lifetime Pro license',
          body: `Thanks for your purchase!\n\nYour license key:\n${key}\n\n` +
                `Paste it into Loadout → Settings → Patreon → License key.\n\n` +
                `Install: https://github.com/aquiloplays/loadout/blob/main/INSTALL.md\n` +
                `Support: https://github.com/aquiloplays/loadout/issues`
        }
      })
    });

    // 3. Discord notification
    await discord.postAnnouncement({
      product: 'loadout',
      title: '💜 New Lifetime Pro buyer',
      body: `Order ${event.data.id} · ${event.data.customer?.email}`,
      channelOverride: process.env.FOURTHWALL_SALES_CHANNEL_ID
    });
  }
  res.json({ ok: true });
});
```

Required new env vars on aquilo-bot:
```
FOURTHWALL_API_KEY=
FOURTHWALL_LIFETIME_PRO_ID=    # set after creating the product on Fourthwall
WORKER_BASE=https://streamfusion-patreon-proxy.bisherclay.workers.dev
```

### Loadout-side changes

Add `src/Loadout.Core/Workers/LicenseClient.cs` (~80 lines, mirrors `SupportersClient.cs` pattern):

```csharp
public sealed class LicenseClient
{
    public static LicenseClient Instance { ... }

    public async Task<string> VerifyAsync(string key)
    {
        // GET /api/loadout-license/lookup?key=<key>
        // Returns "tier3" / "tier2" / "tier1" / null
        // Caches positive results for 24h, negative for 5min
    }

    public string GetCachedTier() => /* from disk */;
}
```

Then in `Patreon/Entitlements.cs`, after the existing tier check:

```csharp
public static bool IsUnlocked(Feature f)
{
    // Patreon path (existing):
    var tier = PatreonClient.Instance.Current.Entitled
        ? PatreonClient.Instance.Current.Tier
        : "none";

    // NEW: Lifetime license overrides Patreon if present + valid.
    var licenseTier = LicenseClient.Instance.GetCachedTier();
    if (licenseTier != null && TierRank(licenseTier) > TierRank(tier))
        tier = licenseTier;

    return IsUnlocked(f, tier);
}
```

Plus a "License key" `TextBox` on the Settings → Patreon tab with a "Verify" button that calls `LicenseClient.VerifyAsync` and shows the result.

### Estimated effort

- Worker changes: 30 minutes (copy the existing handle pattern)
- aquilo-bot changes: 1 hour (Fourthwall fulfillment API requires testing)
- Loadout changes: 2 hours (LicenseClient.cs + Settings UI field + Entitlements check)
- End-to-end testing with a real Fourthwall sandbox order: 1 hour

**Total: ~5 hours of focused work.**

Recommend shipping this in **Loadout v0.2** so v0.1 launches unblocked. List the Lifetime Pro Fourthwall product as "Coming v0.2" in the meantime, with the Patreon Tier 3 page as the live alternative.

---

## Path 3 — Newsletter / community building (works today)

Fourthwall captures customer emails at checkout. To send those emails the Loadout newsletter:

1. Fourthwall → **Customers** → export CSV
2. Import to whatever you use for email (ConvertKit / Mailchimp / Beehiiv)
3. Tag `loadout` so you can segment for Loadout-specific drips

Eventually: webhook every new customer to a `/api/newsletter/subscribe` endpoint that auto-imports. Out of scope for v0.1.

---

## Path 4 — Discord welcome DM (optional, requires bot permission grant)

When a customer joins your Discord (after buying), the bot can DM them a welcome with their license key + setup links. Requires:

- The customer joins your Discord (your existing Discord, the one the announcements bot is in)
- Bot has `GuildMembers` intent + `MESSAGE_CONTENT` intent enabled in the Discord dev portal
- A `guildMemberAdd` listener in `aquilo-bot/src/discord.js` that pulls their email from a Patreon link or Fourthwall order lookup

Defer to phase 2 — moderate complexity, low marginal value over the order-paid email.
