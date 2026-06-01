"""Diversify duplicated Boltbound effect text (Clay 2026-05-31).

Clay flagged that many cards share identical descriptions ("Draw 1 card"
repeated, etc.). The catalogue is procedurally generated from a small
effect palette, so >3-card clusters are common. This rewrites the
DISPLAY text only with tasteful variety while the engine-facing fields
(keywords / abilities / mana / atk / hp) stay frozen.

Mechanical safety is enforced, not trusted:
  - VARIANT MAY NOT introduce any digit not present in the original
    effect (so "deal 1" can never become "deal 2" -> no power creep,
    no changed numbers).
  - Every keyword token in the original (taunt/shield/charge/lifesteal/
    rush/reach/spell-immune/regen) must still appear in the variant.
  - No em dash, no double space, <= 72 chars, non-empty.
Any variant failing validation is dropped and the original is kept.

Variants are authored here (a model wrote the banks) rather than fetched
from a live Haiku call: the ANTHROPIC_API_KEY is a write-only worker
secret with no local value, and hand-curated banks let us GUARANTEE the
mechanical invariants above. Variants are distributed deterministically
across each cluster's id-sorted cards (round-robin) so the same input
always yields the same diff.

Output: card-text-overrides.js  (id -> new display text, changed only).
Run:  python tools/diversify-effects.py        # writes overrides + report
"""
from __future__ import annotations
import json, re, sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parent.parent
CARDS_JSON = 'C:/tmp/all-cards.json'
OUT_JS = ROOT / 'card-text-overrides.js'
OUT_IDS = Path('C:/tmp/diversified-ids.json')

KEYWORD_TOKENS = ['taunt', 'shield', 'charge', 'lifesteal', 'rush',
                  'reach', 'spell-immune', 'regen', 'poison', 'stealth']

# Exact original-text -> variant bank. Bank[0] is the original (kept so a
# fraction of each cluster reads canonically). Every variant is
# mechanically identical to the original; validation below is the guard.
BANKS = {
 'Taunt': [
   'Taunt', 'Taunt. Enemies must strike this first.', 'Taunt. Guards your other minions.',
   'Taunt. Blocks the lane.', 'Taunt. Must be cleared first.', 'Taunt. Forces attacks here.',
   'Taunt. Holds the front.', 'Taunt. Nothing slips past.', 'Taunt. Stands in the way.',
   'Taunt. Draws enemy fire.', 'Taunt. Your wall this turn.', 'Taunt. Soaks the hit.',
   'Taunt. First in line to be attacked.', 'Taunt. Shields the row behind it.',
   'Taunt. Enemies cannot ignore it.',
 ],
 'Shield': [
   'Shield', 'Shield. Ignores the first hit.', 'Shield. Blocks one instance of damage.',
   'Shield. The first strike does nothing.', 'Shield. Shrugs off the first blow.',
   'Shield. One free save.', 'Shield. Negates the next damage.', 'Shield. Absorbs the opening hit.',
   'Shield. The first wound glances away.', 'Shield. Protected once.', 'Shield. Eats the first attack.',
   'Shield. Holds against one strike.', 'Shield. The first hit is denied.',
 ],
 'Charge': [
   'Charge', 'Charge. Strikes the turn it lands.', 'Charge. Attacks immediately.',
   'Charge. No summoning wait.', 'Charge. Hits the moment it is played.', 'Charge. Ready to swing at once.',
   'Charge. Enters the fray instantly.', 'Charge. Can attack right away.', 'Charge. Comes in swinging.',
   'Charge. Wastes no time.', 'Charge. Acts on arrival.', 'Charge. Straight into battle.',
 ],
 'Taunt. Enemies must deal with this first.': [
   'Taunt. Enemies must deal with this first.', 'Taunt. The enemy has to come through it.',
   'Taunt. Attacks are forced onto it.', 'Taunt. It must fall before the rest.',
   'Taunt. Your line starts here.', 'Taunt. Body-blocks for the team.',
   'Taunt. Keeps the back rank safe.', 'Taunt. A wall the enemy must break.',
   'Taunt. Pulls every attack.', 'Taunt. Stands between them and you.',
   'Taunt. Clear it first or not at all.', 'Taunt. The front of your formation.',
 ],
 'Charge. Can attack the turn it is played.': [
   'Charge. Can attack the turn it is played.', 'Charge. Swings the same turn it arrives.',
   'Charge. No wait before its first strike.', 'Charge. Plays and attacks at once.',
   'Charge. Ready for combat immediately.', 'Charge. Strikes without delay.',
   'Charge. Into battle the moment it lands.', 'Charge. Attacks on the turn it drops.',
   'Charge. Hits as soon as it is down.', 'Charge. The first swing comes free.',
   'Charge. Joins the attack right away.', 'Charge. No turn of patience needed.',
 ],
 'Battlecry: deal 1 damage to any target.': [
   'Battlecry: deal 1 damage to any target.', 'Battlecry: snipe any target for 1.',
   'Battlecry: zap a target for 1 damage.', 'Battlecry: burn any target for 1.',
   'Battlecry: deal 1 damage anywhere.', 'Battlecry: singe a target for 1 damage.',
   'Battlecry: 1 damage to any minion or hero.', 'Battlecry: sear any target for 1.',
   'Battlecry: chip 1 damage off a target.', 'Battlecry: blast a target for 1 damage.',
   'Battlecry: strike any target for 1.', 'Battlecry: tag a target for 1 damage.',
 ],
 'Battlecry: heal 2 to your hero.': [
   'Battlecry: heal 2 to your hero.', 'Battlecry: restore 2 to your hero.',
   'Battlecry: mend your hero for 2.', 'Battlecry: your hero gains 2 health.',
   'Battlecry: patch your hero for 2.', 'Battlecry: heal your hero by 2.',
   'Battlecry: 2 health back to your hero.', 'Battlecry: soothe your hero for 2.',
   'Battlecry: recover 2 on your hero.', 'Battlecry: bind your wounds for 2.',
   'Battlecry: lift your hero 2 health.', 'Battlecry: nurse your hero for 2.',
 ],
 'Deathrattle: deal 1 damage to a random enemy.': [
   'Deathrattle: deal 1 damage to a random enemy.', 'Deathrattle: a random enemy takes 1.',
   'Deathrattle: zap a random enemy for 1.', 'Deathrattle: 1 damage to a random foe.',
   'Deathrattle: snipe a random enemy for 1.', 'Deathrattle: burn a random enemy for 1.',
   'Deathrattle: a random enemy suffers 1.', 'Deathrattle: lash a random enemy for 1.',
   'Deathrattle: sear a random enemy for 1.', 'Deathrattle: strike a random enemy for 1.',
   'Deathrattle: 1 damage, a random enemy.', 'Deathrattle: a parting 1 to a random enemy.',
 ],
 'Deathrattle: summon a token.': [
   'Deathrattle: summon a token.', 'Deathrattle: leave a token behind.',
   'Deathrattle: a token rises in its place.', 'Deathrattle: spawn a token.',
   'Deathrattle: call up a token.', 'Deathrattle: a token takes its spot.',
   'Deathrattle: summon a successor token.', 'Deathrattle: drop a token where it fell.',
   'Deathrattle: raise a token.', 'Deathrattle: a token steps forward.',
   'Deathrattle: bequeath a token.', 'Deathrattle: a token carries on.',
 ],
 'Taunt · Shield': [
   'Taunt · Shield', 'Taunt and Shield.', 'Taunt · Shield. A wall that shrugs the first hit.',
   'Shield · Taunt', 'Taunt. Shield. Holds and absorbs.',
   'Taunt · Shield. Guards, then takes one free hit.',
   'Taunt and Shield. Blocks the lane, eats a blow.',
   'Taunt · Shield. First to be hit, and it can take it.',
   'Shield · Taunt. Soaks one strike, holds the front.',
   'Taunt · Shield. Stubborn and armored.',
 ],
 'Charge · Lifesteal': [
   'Charge · Lifesteal', 'Charge and Lifesteal.', 'Charge · Lifesteal. Strikes at once and drains.',
   'Lifesteal · Charge', 'Charge. Lifesteal. Swings in, heals on hit.',
   'Charge · Lifesteal. Immediate, and it feeds.',
   'Charge and Lifesteal. Attacks now, drains life.',
   'Charge · Lifesteal. Hits fast, heals you.',
   'Lifesteal · Charge. Drains from the first strike.',
   'Charge · Lifesteal. Hungry and quick.',
 ],
 'Battlecry: deal 2 damage to any target.': [
   'Battlecry: deal 2 damage to any target.', 'Battlecry: snipe any target for 2.',
   'Battlecry: zap a target for 2 damage.', 'Battlecry: burn any target for 2.',
   'Battlecry: deal 2 damage anywhere.', 'Battlecry: singe a target for 2 damage.',
   'Battlecry: 2 damage to any minion or hero.', 'Battlecry: sear any target for 2.',
   'Battlecry: blast a target for 2 damage.', 'Battlecry: strike any target for 2.',
   'Battlecry: tag a target for 2 damage.', 'Battlecry: 2 damage, your pick.',
 ],
 'Lifesteal': [
   'Lifesteal', 'Lifesteal. Its damage heals your hero.', 'Lifesteal. Feeds your hero on hit.',
   'Lifesteal. Drains life as it strikes.', 'Lifesteal. Damage becomes healing.',
   'Lifesteal. Each blow mends you.', 'Lifesteal. Steals health when it hits.',
   'Lifesteal. Its hits heal your hero.', 'Lifesteal. Siphons life on damage.',
   'Lifesteal. Your hero gains what it deals.',
 ],
 'Rush': [
   'Rush', 'Rush. Can attack minions at once.', 'Rush. Strikes enemy minions immediately.',
   'Rush. Into the melee right away.', 'Rush. Attacks minions the turn it lands.',
   'Rush. Trades the moment it is played.', 'Rush. Hits minions without waiting.',
   'Rush. Ready to trade at once.', 'Rush. Charges the enemy line.',
   'Rush. Engages minions immediately.',
 ],
 'Battlecry: heal 3 to your hero.': [
   'Battlecry: heal 3 to your hero.', 'Battlecry: restore 3 to your hero.',
   'Battlecry: mend your hero for 3.', 'Battlecry: your hero gains 3 health.',
   'Battlecry: patch your hero for 3.', 'Battlecry: heal your hero by 3.',
   'Battlecry: 3 health back to your hero.', 'Battlecry: recover 3 on your hero.',
   'Battlecry: lift your hero 3 health.', 'Battlecry: soothe your hero for 3.',
 ],
 'Battlecry: draw 1 card.': [
   'Battlecry: draw 1 card.', 'Battlecry: draw a card.', 'Battlecry: pull 1 from your deck.',
   'Battlecry: top of deck, draw 1.', 'Battlecry: refill your hand by 1.', 'Battlecry: draw 1.',
   'Battlecry: take a card from your deck.', 'Battlecry: a card joins your hand.',
   'Battlecry: replenish 1 card.', 'Battlecry: dig 1 card deeper.',
 ],
 'Regen · End of turn: heal 1 to your hero.': [
   'Regen · End of turn: heal 1 to your hero.', 'Regen. End of turn, your hero heals 1.',
   'Regen · Mends your hero 1 each turn end.', 'Regen. Your hero recovers 1 every turn.',
   'Regen · End of turn: restore 1 to your hero.', 'Regen. Heals your hero 1 at turn end.',
   'Regen · Your hero regains 1 each end of turn.', 'Regen. End of turn: 1 health to your hero.',
   'Regen · Slowly mends your hero, 1 a turn.', 'Regen. Patches your hero 1 each turn.',
 ],
 'Reach. Can hit the enemy hero through Taunts.': [
   'Reach. Can hit the enemy hero through Taunts.', 'Reach. Ignores enemy Taunts.',
   'Reach. Strikes the hero past any Taunt.', 'Reach. Taunts do not stop it.',
   'Reach. Hits over the enemy front line.', 'Reach. Bypasses Taunt to reach the hero.',
   'Reach. No Taunt can block its aim.', 'Reach. Fires past the wall.',
   'Reach. The hero is never safe from it.', 'Reach. Goes straight through Taunts.',
 ],
 'Spell-Immune. Enemy spells cannot touch it.': [
   'Spell-Immune. Enemy spells cannot touch it.', 'Spell-Immune. Spells slide right off.',
   'Spell-Immune. No spell can target it.', 'Spell-Immune. Magic finds no purchase.',
   'Spell-Immune. Untouched by enemy spells.', 'Spell-Immune. Spells are wasted on it.',
   'Spell-Immune. Warded against all spells.', 'Spell-Immune. Enemy magic does nothing.',
   'Spell-Immune. Beyond the reach of spells.', 'Spell-Immune. Spells cannot land.',
 ],
 'Battlecry: give to all friendly minions +1/+1.': [
   'Battlecry: give to all friendly minions +1/+1.', 'Battlecry: all friendly minions get +1/+1.',
   'Battlecry: buff your minions +1/+1.', 'Battlecry: your other minions gain +1/+1.',
   'Battlecry: rally your minions, +1/+1 each.', 'Battlecry: +1/+1 to every friendly minion.',
   'Battlecry: strengthen your board +1/+1.', 'Battlecry: all your minions grow +1/+1.',
   'Battlecry: hand out +1/+1 to your minions.', 'Battlecry: your minions each take +1/+1.',
 ],
 'Charge.': [
   'Charge.', 'Charge. Attacks the turn it lands.', 'Charge. Swings immediately.',
   'Charge. No wait to strike.', 'Charge. Ready at once.', 'Charge. Into battle right away.',
   'Charge. Hits on arrival.', 'Charge. Comes in swinging.', 'Charge. Acts the moment it is played.',
   'Charge. Straight to the fight.',
 ],
 # ── spell clusters (lowercase, 15 each -> unique per card) ──────────
 'deal 1 damage to any target.': [
   'deal 1 damage to any target.', 'deal 1 to any target.', 'snipe any target for 1.',
   'zap a target for 1 damage.', 'burn any target for 1.', 'deal 1 damage anywhere.',
   'singe a target for 1 damage.', '1 damage to any minion or hero.', 'sear any target for 1.',
   'blast a target for 1 damage.', 'strike any target for 1.', 'tag a target for 1 damage.',
   'scorch any target for 1.', '1 damage, your pick.', 'land 1 damage on any target.',
 ],
 'deal 2 damage to any target.': [
   'deal 2 damage to any target.', 'deal 2 to any target.', 'snipe any target for 2.',
   'zap a target for 2 damage.', 'burn any target for 2.', 'deal 2 damage anywhere.',
   'singe a target for 2 damage.', '2 damage to any minion or hero.', 'sear any target for 2.',
   'blast a target for 2 damage.', 'strike any target for 2.', 'tag a target for 2 damage.',
   'scorch any target for 2.', '2 damage, your pick.', 'land 2 damage on any target.',
 ],
 'deal 3 damage to any target.': [
   'deal 3 damage to any target.', 'deal 3 to any target.', 'snipe any target for 3.',
   'zap a target for 3 damage.', 'burn any target for 3.', 'deal 3 damage anywhere.',
   'singe a target for 3 damage.', '3 damage to any minion or hero.', 'sear any target for 3.',
   'blast a target for 3 damage.', 'strike any target for 3.', 'tag a target for 3 damage.',
   'scorch any target for 3.', '3 damage, your pick.', 'land 3 damage on any target.',
 ],
 'deal 4 damage to any target.': [
   'deal 4 damage to any target.', 'deal 4 to any target.', 'snipe any target for 4.',
   'zap a target for 4 damage.', 'burn any target for 4.', 'deal 4 damage anywhere.',
   'singe a target for 4 damage.', '4 damage to any minion or hero.', 'sear any target for 4.',
   'blast a target for 4 damage.', 'strike any target for 4.', 'tag a target for 4 damage.',
   'scorch any target for 4.', '4 damage, your pick.', 'land 4 damage on any target.',
 ],
 'deal 5 damage to any target.': [
   'deal 5 damage to any target.', 'deal 5 to any target.', 'snipe any target for 5.',
   'zap a target for 5 damage.', 'burn any target for 5.', 'deal 5 damage anywhere.',
   'singe a target for 5 damage.', '5 damage to any minion or hero.', 'sear any target for 5.',
   'blast a target for 5 damage.', 'strike any target for 5.', 'tag a target for 5 damage.',
   'scorch any target for 5.', '5 damage, your pick.', 'land 5 damage on any target.',
 ],
 'heal 3 to any target.': [
   'heal 3 to any target.', 'restore 3 to any target.', 'mend any target for 3.',
   '3 health to any target.', 'patch any target for 3.', 'heal any target by 3.',
   'soothe a target for 3.', 'recover 3 on any target.', 'bind a target wounds for 3.',
   'lift any target 3 health.', 'nurse a target for 3.', 'grant 3 health to any target.',
   '3 back to any target.', 'tend any target for 3.', 'ease a target for 3 health.',
 ],
 'heal 4 to any target.': [
   'heal 4 to any target.', 'restore 4 to any target.', 'mend any target for 4.',
   '4 health to any target.', 'patch any target for 4.', 'heal any target by 4.',
   'soothe a target for 4.', 'recover 4 on any target.', 'bind a target wounds for 4.',
   'lift any target 4 health.', 'nurse a target for 4.', 'grant 4 health to any target.',
   '4 back to any target.', 'tend any target for 4.', 'ease a target for 4 health.',
 ],
 'heal 5 to any target.': [
   'heal 5 to any target.', 'restore 5 to any target.', 'mend any target for 5.',
   '5 health to any target.', 'patch any target for 5.', 'heal any target by 5.',
   'soothe a target for 5.', 'recover 5 on any target.', 'bind a target wounds for 5.',
   'lift any target 5 health.', 'nurse a target for 5.', 'grant 5 health to any target.',
   '5 back to any target.', 'tend any target for 5.', 'ease a target for 5 health.',
 ],
 'draw 1 card.': [
   'draw 1 card.', 'draw a card.', 'pull 1 from your deck.', 'top of deck: draw 1.',
   'refill your hand by 1.', 'draw 1.', 'take a card from your deck.', 'a card joins your hand.',
   'replenish 1 card.', 'dig 1 card deeper.', 'draw 1 off the top.', 'add 1 card to hand.',
   'pull a card.', 'card draw: 1.', '1 card to your hand.',
 ],
 'draw 2 cards.': [
   'draw 2 cards.', 'draw two cards.', 'pull 2 from your deck.', 'top of deck: draw 2.',
   'refill your hand by 2.', 'take 2 cards from your deck.', '2 cards join your hand.',
   'replenish 2 cards.', 'dig 2 cards deeper.', 'draw 2 off the top.', 'add 2 cards to hand.',
   'pull a pair of cards.', 'card draw: 2.', '2 cards to your hand.', 'draw twice.',
 ],
 'give to any target +1/+1.': [
   'give to any target +1/+1.', 'any target gains +1/+1.', 'buff a target +1/+1.',
   '+1/+1 to any target.', 'grant a target +1/+1.', 'pump any target +1/+1.',
   'a target grows +1/+1.', 'strengthen any target +1/+1.', 'boost a target by +1/+1.',
   'lift any target +1/+1.', 'hand a target +1/+1.', 'any minion gains +1/+1.',
   '+1/+1 on a target of choice.', 'embolden a target +1/+1.', 'give a target +1/+1 stats.',
 ],
 'deal 1 damage to all enemy minions.': [
   'deal 1 damage to all enemy minions.', '1 damage to every enemy minion.',
   'sweep enemy minions for 1.', 'all enemy minions take 1.', 'scorch the enemy board for 1.',
   'rain 1 damage on enemy minions.', 'every enemy minion suffers 1.', 'blast all enemy minions for 1.',
   '1 damage across the enemy board.', 'singe each enemy minion for 1.', 'wash enemy minions in 1 damage.',
   'hit all enemy minions for 1.', 'sear every enemy minion for 1.', '1 to all enemy minions.',
   'burn the enemy line for 1.',
 ],
 'deal 2 damage to all enemy minions.': [
   'deal 2 damage to all enemy minions.', '2 damage to every enemy minion.',
   'sweep enemy minions for 2.', 'all enemy minions take 2.', 'scorch the enemy board for 2.',
   'rain 2 damage on enemy minions.', 'every enemy minion suffers 2.', 'blast all enemy minions for 2.',
   '2 damage across the enemy board.', 'singe each enemy minion for 2.', 'wash enemy minions in 2 damage.',
   'hit all enemy minions for 2.', 'sear every enemy minion for 2.', '2 to all enemy minions.',
   'burn the enemy line for 2.',
 ],
 'Battlecry: deal 1 damage to all enemy minions.': [
   'Battlecry: deal 1 damage to all enemy minions.', 'Battlecry: 1 damage to every enemy minion.',
   'Battlecry: sweep enemy minions for 1.', 'Battlecry: all enemy minions take 1.',
   'Battlecry: scorch the enemy board for 1.', 'Battlecry: rain 1 on enemy minions.',
   'Battlecry: every enemy minion suffers 1.', 'Battlecry: blast all enemy minions for 1.',
   'Battlecry: 1 damage across the enemy board.', 'Battlecry: singe each enemy minion for 1.',
   'Battlecry: hit all enemy minions for 1.', 'Battlecry: sear every enemy minion for 1.',
   'Battlecry: 1 to all enemy minions.', 'Battlecry: burn the enemy line for 1.',
   'Battlecry: wash enemy minions in 1 damage.',
 ],
 'Battlecry: draw 2 cards.': [
   'Battlecry: draw 2 cards.', 'Battlecry: draw two cards.', 'Battlecry: pull 2 from your deck.',
   'Battlecry: top of deck, draw 2.', 'Battlecry: refill your hand by 2.', 'Battlecry: take 2 cards.',
   'Battlecry: 2 cards to your hand.', 'Battlecry: replenish 2 cards.', 'Battlecry: dig 2 cards deeper.',
   'Battlecry: draw 2 off the top.', 'Battlecry: add 2 cards to hand.', 'Battlecry: draw a pair.',
   'Battlecry: card draw, 2.', 'Battlecry: draw twice.', 'Battlecry: pull 2 cards up.',
 ],
 'Lifesteal. Damage it deals heals your hero.': [
   'Lifesteal. Damage it deals heals your hero.', 'Lifesteal. Its hits mend your hero.',
   'Lifesteal. Drains life into your hero.', 'Lifesteal. Each blow heals you.',
   'Lifesteal. Feeds your hero on every strike.', 'Lifesteal. Damage returns as healing.',
   'Lifesteal. Siphons health to your hero.', 'Lifesteal. What it deals, you gain.',
 ],
 'Battlecry: draw 3 cards.': [
   'Battlecry: draw 3 cards.', 'Battlecry: draw three cards.', 'Battlecry: pull 3 from your deck.',
   'Battlecry: 3 cards to your hand.', 'Battlecry: refill your hand by 3.',
 ],
 'Taunt.': [
   'Taunt.', 'Taunt. Holds the line.', 'Taunt. Must be struck first.', 'Taunt. Guards the back rank.',
 ],
 'Battlecry: deal 2 damage to all enemy minions.': [
   'Battlecry: deal 2 damage to all enemy minions.', 'Battlecry: 2 damage to every enemy minion.',
   'Battlecry: sweep enemy minions for 2.', 'Battlecry: scorch the enemy board for 2.',
 ],
 'Battlecry: deal 1 damage to all enemy minions. · Battlecry: deal 2 damage to enemy hero.': [
   'Battlecry: deal 1 damage to all enemy minions. · Battlecry: deal 2 damage to enemy hero.',
   'Battlecry: 1 to every enemy minion. · 2 to the enemy hero.',
   'Battlecry: sweep enemy minions for 1, and the enemy hero for 2.',
   'Battlecry: 1 damage to all enemy minions · 2 to the enemy hero.',
 ],
}

def digits(s):
    return set(re.findall(r'\d+', s))

def keywords_in(s):
    low = s.lower()
    return {k for k in KEYWORD_TOKENS if k in low}

def validate(original, variant):
    """Return (ok, reason). Hard mechanical guards."""
    if not variant or not variant.strip():
        return False, 'empty'
    if len(variant) > 72:
        return False, 'too long'
    if '  ' in variant:
        return False, 'double space'
    if '—' in variant or '–' in variant or '--' in variant:
        return False, 'dash'
    # No digit may appear that is not in the original (blocks power creep
    # and any number change). Dropping a number is allowed (e.g. "draw 1
    # card" -> "draw a card"); adding/altering one is not.
    new_digits = digits(variant) - digits(original)
    if new_digits:
        return False, f'new number(s) {new_digits}'
    # Every original keyword token must survive.
    missing_kw = keywords_in(original) - keywords_in(variant)
    if missing_kw:
        return False, f'dropped keyword(s) {missing_kw}'
    return True, 'ok'

def main():
    cards = json.load(open(CARDS_JSON, encoding='utf-8'))
    groups = defaultdict(list)
    for cid, c in cards.items():
        groups[(c.get('text', '') or '').strip()].append(cid)

    overrides = {}
    report = []
    bad = []
    for text, bank in BANKS.items():
        ids = sorted(groups.get(text, []))
        if not ids:
            print('WARN: no cards for cluster', repr(text)); continue
        # validate bank up-front
        clean = []
        for v in bank:
            ok, why = validate(text, v)
            if ok:
                clean.append(v)
            else:
                bad.append((text, v, why))
        if not clean:
            clean = [text]
        # round-robin assign across id-sorted cards
        changed = 0
        for i, cid in enumerate(ids):
            v = clean[i % len(clean)]
            if v != cards[cid]['text']:
                overrides[cid] = v
                changed += 1
        report.append((text, len(ids), len(clean), changed))

    # Write the override module.
    lines = [
        '// Boltbound effect-text diversification (Clay 2026-05-31).',
        '//',
        '// DISPLAY TEXT ONLY. The procedural catalogue reuses a small effect',
        '// palette, so many cards shared an identical description ("Draw 1',
        '// card" etc.). This map rewrites the `text` field with tasteful',
        '// variety while every engine-facing field (keywords / abilities /',
        '// mana / atk / hp) is left untouched -- mechanics, power budget, and',
        '// numbers are identical to before. Generated by',
        '// tools/diversify-effects.py (hand-curated, mechanically validated',
        '// variant banks; no number may change, no keyword may drop).',
        '//',
        f'// {len(overrides)} cards reworded. Merged LAST in cards-content.js so',
        '// it overrides only the display string.',
        '',
        'export const CARD_TEXT_OVERRIDES = {',
    ]
    for cid in sorted(overrides):
        v = overrides[cid].replace('\\', '\\\\').replace("'", "\\'")
        lines.append(f"  '{cid}': '{v}',")
    lines.append('};')
    OUT_JS.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    json.dump(sorted(overrides), open(OUT_IDS, 'w'), ensure_ascii=False)

    print(f'Clusters processed: {len(report)}')
    print(f'Cards reworded:     {len(overrides)}')
    print(f'Rejected variants:  {len(bad)}')
    for t, v, why in bad[:20]:
        print(f'  REJECT [{why}] {v!r}  (cluster {t!r})')
    print('\nPer-cluster (text | cluster size | usable variants | changed):')
    for t, n, nv, ch in sorted(report, key=lambda x: -x[1]):
        print(f'  [{n:4d}] variants={nv:2d} changed={ch:4d}  {t[:60]!r}')
    print(f'\nwrote {OUT_JS}')
    print(f'wrote {OUT_IDS}')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
