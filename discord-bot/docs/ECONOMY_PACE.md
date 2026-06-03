# Economy pace, v2 (2026-05)

Direction set by Clay: **encourage frequent activity, don't make things feel impossible**. Smaller per-action payouts, longer cooldowns, steeper level curves. Daily loops still pay enough to feel worth doing, they just don't compound into runaway wallets.

The central knob is `ECONOMY_PACE = 0.4` in [`economy-pace.js`](../economy-pace.js). Every grant + cooldown in the codebase reads from that module. To re-tune the whole game, edit that one constant and re-run the test suite.

## How to use the helpers

| Helper | Direction | Use for |
|---|---|---|
| `paceBolts(n)`     | `n * 0.4`, min 1 | per-action payouts (counting milestone, achievement, match-win) |
| `paceMilestone(n)` | `n * 0.5`, min 1 | one-time streak / milestone payouts where the moment should feel a bit more ceremonial |
| `paceCooldown(ms)` | `ms / 0.4`       | "wait N min between actions" timers, slower = longer |
| `paceFunnel(n)`    | unchanged        | one-time funnel-boost grants (onboarding completion, referral payout) |

## Per-system before → after

### Daily check-in (`community-checkin.js`)

| | v1 | v2 |
|---|---|---|
| Base daily   | **5 bolts** | **2 bolts** |
| 7-day streak | +5 bolts | +3 bolts |
| 30-day streak | +15 bolts | +8 bolts |
| 100-day streak | +50 bolts | +25 bolts |
| 30-day grand total (perfect run) | 150 + 5 + 15 = **170 bolts** | 60 + 3 + 8 = **71 bolts** |

### Counting (`aquilo/counting.js`)

v1 paid 1 bolt per correct count plus a floor(num/100)+1 multiplier, a perfect 100-count run minted ~150 bolts. v2 switches to **drip semantic**:

| Trigger | v1 | v2 |
|---|---|---|
| Any correct count | +1 bolt | **0** |
| Multiple of 5 | +1 (same as above) | **+1** |
| Multiple of 25 | +1 (same as above) | **+1 extra** (= 2 total at 25) |
| Multiple of 100 | +1 (with ×2 multiplier = 2) | **+5 extra** (= 7 total at 100) |
| 100-count run total | ~150 bolts | **29 bolts** |

The fail penalty (10 bolts) stays unchanged, it's a deterrent, not a payout knob.

### Quick games (`games-quick.js`)

| | v1 | v2 |
|---|---|---|
| Cooldown between plays | 2.5s | **5s** |
| Net win cap per game | unbounded | **+1000 bolts max above bet** |

Wagers and odds (36× roulette number bet, 2.5× blackjack natural, etc.) are unchanged. The cap stops a lucky streak of high-stake wins from minting 50k bolts. A 10-bolt roulette number bet still pays out the full 360 (cap doesn't trip); a 1000-bolt bet on the same caps at 2000 instead of 36000.

### Boltbound match wins (`cards-match.js`)

| | v1 | v2 |
|---|---|---|
| NPC win | 10 bolts | **4 bolts** |
| PvP win | 50 bolts | **20 bolts** |
| Daily ladder cap | 500 bolts/day | **200 bolts/day** |

Pack drops, trophies, and the "I won" log are unchanged, losing a match still feels like losing, the payout is just smaller.

### Clash donation → XP (`clash.js`)

| | v1 | v2 |
|---|---|---|
| Bolts per 1 XP | 100 | **250** |
| Per-day XP cap (table-driven) | 50 | 50 (unchanged) |

Donating treasury still earns XP, just at a slower rate. Cap stays so big spenders can't burn straight to L100.

### XP level curve (`progression/xp.js`)

`xpToReach(level)` doubled both polynomial coefficients:

| | v1 | v2 |
|---|---|---|
| Formula | `100·L + 30·L^1.6` | `200·L + 60·L^1.6` |
| Reach L2   | 291 XP | **582** |
| Reach L10  | ~2.2k  | **4,389** |
| Reach L25  | ~7.7k  | **15,348** |
| Reach L50  | ~20.7k | **41,369** |
| Reach L100 | ~57.5k | **115,094** |

The per-event XP grants in `xp-table.js` are unchanged, the curve carries the slowdown.

### Pet care cooldown (`pet.js`)

| | v1 | v2 |
|---|---|---|
| Feed / Play / Clean | 30 min | **75 min** |
| Re-adopt cooldown | 24h | 24h (unchanged, release punishment, not a grind knob) |

## What was NOT changed (and why)

| System | Reason |
|---|---|
| **Onboarding completion** (100 bolts + bolt pack) | One-time per-user funnel boost. Bootstraps new viewers into the loop, should remain valuable enough to feel like a real welcome. |
| **Referral first-milestone** (50 bolts + bolt pack) | Same: one-time, funnel-shaped. Reducing it would hurt the network-effect flywheel. |
| **Counting fail penalty** (10 bolts) | Deterrent, not a payout. Stays. |
| **Gifter roles** (sub/tiktok/cheer top-3) | Already ceremonial, they grant a Discord role, not bolts. Nothing to retune. |
| **Achievements** | Per the audit, the achievement system does NOT grant bolts. Achievements grant cosmetic roles. Nothing to halve. |
| **Tournament prizes** | No tournament-prize constants were found in the codebase audit. When tournaments ship, they should size their top-3 against the new economy floor, but there's nothing to retune today. |
| **Boltbound trophy progression** (+3 NPC win, +12 PvP) | Trophies aren't bolts. Climbing the ladder still feels real. |
| **Pet feed/play/clean COSTS** (10/5/5 bolts) | Costs aren't payouts. Slowing payouts AND lowering costs would double-nerf the pet loop. Costs stay. |
| **Quick-game wager** (player risks N bolts) | Wager mechanic is unchanged, only the upside cap moved. |
| **Boltbound buy-pack price** (250 bolts) | Same, costs not payouts. |

## How to re-tune

1. Edit `ECONOMY_PACE` in `economy-pace.js`. Lower = slower / more grindy. Higher = faster.
2. Run `node discord-bot/test/test-economy-pace.mjs`, the test pins every paced value, so any unintended drift in a downstream module trips a failure.
3. Update this doc's "before → after" table with the new numbers.
4. `wrangler deploy`.

To carve out an exception (a single payout that shouldn't follow PACE), use `paceFunnel(n)` instead of `paceBolts(n)`, it documents the intent and is a single grep target if Clay ever wants to bring exceptions back in line.
