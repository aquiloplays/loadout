// Adventure premise catalogue — ~10 D&D one-shots the AI GM rolls
// between when a campaign starts. Each premise is a tight setup
// (location, hook, antagonist, twist) the GM expands into a 3-5 hour
// session.
//
// Voice rules (the GM's system prompt enforces them, but the
// premise copy here sets the tone too):
//   • No "ah brave adventurer" cliches
//   • No em dashes
//   • Concise, slightly dry / dark-humoured
//   • Grounded, not "the multiverse trembles" energy
//
// Each entry:
//   id         stable slug (used in DB session.premise_id)
//   title      short title
//   hook       one-paragraph setup the GM seeds with
//   tags       informational, used to vary GM prompt nudges
//
// Pick via `pickPremise()` (weighted-random, but each premise gets
// roughly equal odds; the API surface is just an array index).

export const PREMISES = [
  {
    id: 'lighthouse-kraken',
    title: 'The Lighthouse Keeper',
    hook: 'A coastal town hires the party because their lighthouse keeper has gone strange. Lights at the wrong hours. Ships avoiding the bay. The keeper himself is the kraken, has been for nine years, and is tired of pretending.',
    tags: ['mystery', 'coastal', 'shapechange', 'no-villain'],
  },
  {
    id: 'wedding-poison',
    title: 'The Noble Wedding',
    hook: "A merchant noble's daughter is being married off. Someone is poisoning the wine, but not killing anyone (yet) just making them sick at carefully chosen times. The party is hired as security. Three guests have separate motives to want the wedding off.",
    tags: ['social', 'mystery', 'investigation', 'no-combat-start'],
  },
  {
    id: 'crypt-bargain',
    title: 'The Bargaining Lich',
    hook: 'An abandoned crypt under a hill village. The lich inside is not interested in conquest. He wants someone to mediate a property dispute with the village above. He has been sending demands. The village has not been sending replies. The party walks in mid-grievance.',
    tags: ['undead', 'roleplay-heavy', 'absurd', 'no-clear-villain'],
  },
  {
    id: 'goblin-strike',
    title: 'The Goblin Wage Dispute',
    hook: "A mining company hired goblin labour. The goblins have organised. They are not raiding the company. They are blocking the road to it, with paperwork. The company wants the road cleared. The goblins want an attorney. The party gets between them.",
    tags: ['social', 'goblins', 'comedy-leaning', 'no-easy-answer'],
  },
  {
    id: 'forest-time',
    title: 'The Wrong Forest',
    hook: 'A trade caravan went into a forest seven days ago. It came out yesterday. The merchants insist they were gone seven days. They look like they aged seven years. None of them remember anything. The party is paid to retrace their route.',
    tags: ['horror-leaning', 'fey', 'time-warp', 'investigation'],
  },
  {
    id: 'dragon-debt',
    title: 'The Dragon\'s Accountant',
    hook: "A young dragon, two centuries old, has hired an accountant from the local thieves' guild to recover loans she made to a now-defunct trading house. The accountant has been arrested by the city watch for unpaid taxes on the loan income. The dragon wants her freed without burning down the city. The party is the intermediary.",
    tags: ['dragon', 'political', 'no-combat-first', 'absurd'],
  },
  {
    id: 'temple-twins',
    title: 'The Temple of Two Names',
    hook: "A frontier temple's congregation is split. Half of them worship a gentle harvest god. Half worship a vengeful storm god. They have been doing this in the same building, at alternating hours, for forty years. Last week one priest from each side disappeared. Both factions blame the other. Both factions are wrong.",
    tags: ['mystery', 'religion', 'investigation', 'cult-adjacent'],
  },
  {
    id: 'caravan-courier',
    title: 'The Courier Job',
    hook: 'A locked box from one city to another, three days hard riding. The party are couriers, paid well. Halfway there they realise the box is humming. Halfway after that, things start hunting the box and not them. Then the box starts talking.',
    tags: ['road', 'mystery', 'escalating', 'object-as-NPC'],
  },
  {
    id: 'silver-mine',
    title: 'The Mine Beneath The Mine',
    hook: 'A silver mine in the hills has been productive for six generations. The current owner just hit a new vein. Below the new vein is an older mine, dressed stone, perfectly preserved, that should not exist. Two surveyors are already missing in it. The owner needs the survey finished before his investors visit.',
    tags: ['dungeon', 'ancient', 'investigation', 'time-pressure'],
  },
  {
    id: 'inn-haunt',
    title: 'The Inn That Forgets',
    hook: "Every guest at the Brindlewood Inn wakes up having forgotten their stay. Each one separately. The innkeeper has noticed. He's quietly been writing his guests' names in a ledger for three years. The names number in the hundreds. None of them remember being there. He cannot leave.",
    tags: ['horror-leaning', 'investigation', 'roleplay-heavy', 'no-monster'],
  },
];

export function pickPremise(rng = Math.random) {
  return PREMISES[Math.floor(rng() * PREMISES.length)];
}

export function premiseById(id) {
  return PREMISES.find(p => p.id === id) || null;
}
