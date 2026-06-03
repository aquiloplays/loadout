# Aquilo bolts, unified economy reference

Bolts (⚡) are the unified currency across every Aquilo product:

- the Loadout DLL (dungeons, mini-games, shop)
- the Loadout Discord bot (`/loadout`, `/stocks`, `/bet`)
- Aquilo's Vault Discord bot (its own separate shelter-builder game in
  its own repo; credits via signed Worker delta, see §HMAC routes)
- the Twitch panel extension (read-only views + Bits-funded loot boxes)

There is one wallet per (guild, user) pair, stored at
`wallet:<guildId>:<userId>` in the shared `LOADOUT_BOLTS` KV namespace.
Every earn / spend lands there.

This file is the canonical reference for every path that touches a wallet.
Update it when you add a new earn or spend.

## Wallet record

```
KV key: wallet:<guildId>:<userId>
Value:
{
  balance: int,            // current bolts
  lifetimeEarned: int,     // monotonic total earned
  lifetimeSpent: int,      // monotonic total spent
  lastEarnUtc: int,        // Date.now() of last credit
  lastEarnReason: string,
  lastSpendUtc: int,
  lastSpendReason: string,
  dailyStreak: int,        // consecutive days /loadout daily ran
  lastDailyUtc: int,
  links: [{ platform, username }, ...]  // linked stream identities
}
```

Helpers in `wallet.js`:
- `getWallet(env, guildId, userId)`, defaults to a zero wallet
- `earn(env, guildId, userId, amount, reason)`, credits, returns the updated wallet
- `spend(env, guildId, userId, amount, reason)`, debits, returns `{ ok, balance, wallet?, reason? }`
- `transfer(env, guildId, fromId, toId, amount)`, atomic gift between users
- `applyVaultDelta(env, guildId, userId, amount, reason)`, signed credit/debit
  from Aquilo's Vault bot (HMAC-verified at the Worker edge)

## Earn paths

| Source | Where | Reason tag | Notes |
|---|---|---|---|
| Daily claim | `loadout-menu.js` → `daily()` | `daily:<streak>` | `/loadout` → Daily button; cooldown 22h; streak multiplier |
| Check-in | `CheckInModule.cs` (DLL) → `bolts.earned` bus event → Worker `bolts.earned` consumer credits wallet | `checkin` | Twitch chat `!checkin` or channel-point redemption |
| Mini-game wins (DLL) | `BoltsModule.cs` → `BoltsWallet.Earn` (local DLL store) → `Discord.DiscordSync` propagates to wallet via the auto-sync timer | `coinflip:win`, `dice:win:<n>`, `slots:two`, `roulette:win:<color>`, `rps:win`, etc. | DLL-side hero balance + Worker wallet kept in sync every 30 s |
| Mini-game wins (Discord bot) | `games.js` in `commands.js` flow | `coinflip:win`, `dice:win:<roll>` | `/loadout` → Quick games → coinflip / dice modal |
| Dungeon outcomes | DLL → `BoltsWallet.Earn`, then synced to wallet | `dungeon` | per-survivor gold from `DungeonOutcome.GoldGained` |
| Heist payouts | DLL `HeistController` | per-payout reason | `bolts.heist.success` event credits party |
| Sub anniversary bonus | `SubAnniversaryModule.cs` | `sub:anniversary:<months>` | tier-driven payout |
| Tip received | `TipBridge.cs` (DLL) | `tip:<provider>` | Streamlabs / SE / Ko-fi / generic webhook |
| Stock sale (Worker) | `stocks.js` → `runSell` → `earn(...)` | `stocks-sell:<TICKER>` | gross − 1 % fee = credited amount |
| Bet win (Worker) | `bet.js` → `betCronTick` → `earn(...)` | `bet-win:<gameId>` | payout = stake × moneyline × 0.975 (or × 1.95 even-money) |
| Bet refund (Worker) | `bet.js` cron settles a tie/postponed game | `bet-refund:<gameId>` | exact stake credited back |
| Gift received | `wallet.js` → `transfer()` | `gift:from:<fromId>` | from `/loadout` → Gift modal |
| Vault bot credit | `worker.js` `/sync/:guild` → `applyVaultDelta` (HMAC-gated) | `vault:<reason>` | Aquilo's Vault bot in the Discord guild fires this on its own reward events |
| Discord bot leaderboard catch-up | `wallet.js` admin tools | `admin:adjust` | manual sync if drift detected |

## Spend paths

| Sink | Where | Reason tag | Notes |
|---|---|---|---|
| Shop buy | `dungeon.js` → `doShopBuy` (writes hero, debits via internal bolts) | `shop:buy:<itemId>` | `/loadout` → Shop |
| Training | `dungeon.js` → `doTrain` | `train` | `/loadout` → Train (30 bolts/round) |
| Gift sent | `wallet.js` → `transfer()` → `spend()` | `gift:to:<toId>` | the spend side of a transfer |
| Mini-game stake (Discord bot) | `games.js` | `coinflip:wager`, `dice:wager` | wagered amount debited before the roll |
| Mini-game stake (DLL) | `BoltsModule.cs` (chat-driven `!coinflip` etc.) | `bolts:<game>:wager` | mirrors to wallet via DiscordSync |
| Heist contribution | `HeistController` | `bolts:heist:contribute` | per-player stake |
| Stock buy | `stocks.js` → `runBuy` → `spend(...)` | `stocks-buy:<TICKER>` | shares × price + 1 % fee |
| Bet stake | `bet.js` → `runPlace` → `spend(...)` | `bet-stake:<gameId>` | debited at place-time; settlement may return stake (refund) or payout (win) |
| Dungeon cooldown skip (bolts) | `ext-panelbridge.js` → `skipCooldown` → `spend(env, ..., 500, 'dungeon-skip-cooldown')` | `dungeon-skip-cooldown` | 500 bolts; alternative path is 100 Bits (no wallet impact) |

## Bits paths (NOT wallet-touching)

The Loadout system uses Twitch Bits in three places. These are separate from
bolts, Bits receipts gate access to a feature but never become bolts:

| Surface | SKU | Cost | What it gates |
|---|---|---|---|
| Loot boxes | `loot_box` | 50 bits | `POST /ext/lootbox/roll`, drops one item into the viewer's `hero.bag` |
| Dungeon cooldown skip | `dungeon_skip_cooldown` | 100 bits | clears the channel cooldown + auto-starts a dungeon |
| Song requests | `song_request` | per-channel config | `POST /ext/rotation/request`, paid path when the viewer has no free quota |

Bits receipts are verified server-side via `verifyBitsReceipt` in `auth.js` (HMAC
against `TWITCH_EXT_SECRET`). The wallet is **not** credited from Bits; Bits go
directly to Clay's Twitch payout.

## Cross-product wallet sync

Five surfaces read/write the same wallet:

1. **Loadout DLL**, local `BoltsWallet` (`hero.bag` + balance), auto-synced
   every 30 s by `Discord.DiscordSync` to the Worker `wallet:<g>:<u>` record.
2. **aquilo.gg Discord bot** (this Worker), direct reads + writes via the
   `earn` / `spend` helpers.
3. **Aquilo's Vault Discord bot** (`FS Bot/bot.py`), credits via signed POST
   to `<worker>/sync/<guildId>` which calls `applyVaultDelta`. Only the
   designated guild ID can credit.
4. **Twitch panel extension**, reads via `/ext/wallet` (JWT-gated), spends via
   the same flows the Discord bot exposes (`/ext/lootbox/roll`,
   `/ext/dungeon/skip-cooldown`).
5. **aquilo-site Pages**, `/api/admin/*` and `/api/link/*` write to specific
   sub-records (`tw_patreon:tw:<id>`, etc.) but do **not** mutate the wallet
   balance.

## KV keys touched by the economy

| Key | Owner | Used by |
|---|---|---|
| `wallet:<guildId>:<userId>` | `wallet.js` | every product |
| `stock:price:<TICKER>` | `stocks.js` cron | read by Worker + panel |
| `stock:history:<TICKER>` | `stocks.js` cron | chart rendering |
| `stock:holdings:<guildId>:<userId>` | `stocks.js` | buy/sell |
| `bets:user:<guildId>:<userId>` | `bet.js` | active + history |
| `bets:open:<gameId>` | `bet.js` | cron settlement index |
| `sports:games:cache` | `bet.js` cron | game list (2h TTL) |
| `sports:teams:registry` | `bet.js` cron + `seedTeamRegistry` | team-subscription search |
| `sports:subs:user:<userId>:{leagues,teams}` | `hub-menu.js` | per-user lists |
| `sports:subs:{league,team}:*` | `hub-menu.js` | reverse-index for cron mentions |
| `sports:channel:guild:<guildId>` | `admin-menu.js` + `bet.js` cron | feed channel + knownGameIds |
| `stocks:ticker:guild:<guildId>` | `stocks.js` | auto-update channel board |
| `cmdcd:<viewerId>:<action>` | `ext-panelbridge.js` | per-viewer panel-cmd debounce |
| `relay:dll-pending:<ts>` | `ext-panelbridge.js` | panel-cmd queue |
| `helix:login:<userId>` | `ext-loadout.js` | Twitch user_id → login cache (24h) |
| `tw_patreon:tw:<id>` | `aquilo-site` Pages | Twitch → Patreon mapping for panel patron-corner |

## Worker routes that touch bolts

| Route | Auth | Effect |
|---|---|---|
| `GET /ext/wallet` | Ext JWT | read balance + links |
| `GET /ext/hero` | Ext JWT | read hero (balance side-loaded) |
| `POST /ext/daily` | Ext JWT | claim daily; calls `earn` |
| `POST /ext/checkin` | Ext JWT | record check-in; emits earn |
| `POST /ext/loadout/shop-buy` | Ext JWT | shop purchase; calls `spend` |
| `POST /ext/loadout/sell` | Ext JWT | sell bag item; calls `earn` |
| `POST /ext/loadout/train` | Ext JWT | training cost; calls `spend` |
| `POST /ext/lootbox/roll` | Ext JWT + Bits receipt | Bits → bag (no bolts) |
| `POST /ext/dungeon/skip-cooldown` | Ext JWT | either Bits OR 500-bolt `spend` |
| `POST /ext/{dungeon,minigame}/cmd` | Ext JWT | enqueues for DLL replay; bolts spend on DLL side |
| `POST /sync/:guild` | HMAC `AQUILO_VAULT_BOLTS_SECRET` | `applyVaultDelta`, Vault bot crediting |

## Adding a new earn or spend

1. Pick a memorable `reason` tag (e.g. `feature:context`). It surfaces in the
   wallet's `lastEarn/SpendReason` and feeds debug + analytics.
2. Call `earn` / `spend` from `wallet.js`. Don't write the wallet record
   directly, those helpers handle lifetime totals + timestamps.
3. Add a row to the appropriate table above. The grep
   `grep -rn 'await (earn|spend)' discord-bot --include=*.js` should match
   your new caller.
4. If the new flow has a KV key dedicated to it, add a row to the KV-keys
   table.
