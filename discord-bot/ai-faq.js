// AI FAQ helper — /ask answers common Aquilo questions to deflect tickets.
// Uses an LLM (Anthropic) when ANTHROPIC_API_KEY is set, grounded in the
// curated FAQ below; falls back to keyword-matching the FAQ otherwise, so it
// works even without a key.

const FLAG_EPHEMERAL = 64;

// Curated Aquilo knowledge — the LLM's grounding context AND the no-key fallback.
export const FAQ = [
  {
    q: 'How do I link my accounts / sign in?',
    keywords: ['link', 'connect', 'sign in', 'signin', 'login', 'log in', 'account', 'twitch', 'kick', 'youtube'],
    a: 'Sign in and connect your platforms at **aquilo.gg** — you can link Twitch, Discord, YouTube, and Kick to one Aquilo account. On iPhone, add aquilo.gg to your Home Screen first, then sign in.',
  },
  {
    q: 'What are Bolts? Do I have to pay for anything?',
    keywords: ['bolts', 'currency', 'economy', 'pay', 'cost', 'free', 'money', 'price'],
    a: 'Every feature in the Aquilo ecosystem is **free**. Bolts are a fun on-stream currency for mini-games and perks — you earn them by watching and taking part, never by paying.',
  },
  {
    q: 'What do Patreon / Supporter perks get me?',
    keywords: ['patreon', 'supporter', 'perks', 'subscribe', 'membership', 'tier', 'donate', 'gift'],
    a: 'Supporting on **Patreon** (patreon.com/aquilo) is optional and unlocks early access to new creator tools plus supporter roles — but all core features stay free. You can also gift a membership with `/gift`.',
  },
  {
    q: 'When does Aquilo stream? What is the schedule?',
    keywords: ['schedule', 'stream', 'when', 'live', 'time', 'community night', 'saturday'],
    a: "Aquilo streams most nights, roughly **10:30pm–12:30am ET**, with **Saturday Community Night** for playing together. The schedule embed in the server has the details (vacations are posted there too).",
  },
  {
    q: 'How do I check in / keep my streak?',
    keywords: ['checkin', 'check in', 'check-in', 'streak', 'daily', 'punchcard'],
    a: 'Use `/checkin` here in Discord, or check in on **aquilo.gg** — one check-in per day keeps your streak alive, and streaks earn rewards.',
  },
  {
    q: 'What are StreamFusion / Loadout / the overlays?',
    keywords: ['streamfusion', 'loadout', 'overlay', 'overlays', 'obs', 'tools', 'rotation', 'jukebox', 'goals'],
    a: 'Those are Aquilo’s free creator tools — chat overlays, alerts, goals, song requests, check-in cards, and more. Browse and set them up at **aquilo.gg → Creator Tools**.',
  },
  {
    q: 'I found a bug / something is broken.',
    keywords: ['bug', 'broken', 'error', 'not working', 'doesnt work', 'issue', 'glitch', 'crash'],
    a: 'Sorry about that! Open a **support ticket** in **#support** (pick the 🐛 Bug category) with what happened and any screenshots, and a mod will jump in.',
  },
  {
    q: 'How do I get help or talk to a mod?',
    keywords: ['help', 'support', 'ticket', 'mod', 'staff', 'contact', 'human'],
    a: 'Open a **ticket** in **#support** — pick a category, add a short description, and the mod team (and Aquilo) are notified right away.',
  },
];

function scoreEntry(entry, q) {
  const t = q.toLowerCase();
  let s = 0;
  for (const k of entry.keywords) if (t.includes(k)) s += k.length; // longer match = stronger signal
  return s;
}

function curatedAnswer(question) {
  const ranked = FAQ.map((e) => ({ e, s: scoreEntry(e, question) })).sort((a, b) => b.s - a.s);
  const top = ranked[0];
  if (top && top.s >= 4) {
    return `**${top.e.q}**\n${top.e.a}\n\n_Not what you needed? Open a ticket in **#support**._`;
  }
  return "I don't have a quick answer for that one — please open a **ticket** in **#support** (pick a category and describe it) and the mod team will help.";
}

async function llmAnswer(env, question) {
  const sys = [
    'You are the friendly Aquilo community assistant in a Discord server.',
    "Answer the member's question briefly (2-4 sentences), warm and helpful, using ONLY the facts below.",
    "If the facts don't cover it, say you're not sure and suggest opening a ticket in #support. Never invent policies, prices, or links.",
    'Facts:',
    ...FAQ.map((e) => `- ${e.q} ${e.a}`),
  ].join('\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: sys,
      messages: [{ role: 'user', content: String(question).slice(0, 1000) }],
    }),
  });
  if (!r.ok) return null;
  const body = await r.json().catch(() => null);
  const text = (body?.content || []).map((c) => c.text || '').join('').trim();
  return text || null;
}

export async function answerQuestion(env, question) {
  const q = String(question || '').trim();
  if (!q) return 'Ask me anything about Aquilo — e.g. `/ask how do I link my accounts?`';
  if (env.ANTHROPIC_API_KEY) {
    try {
      const a = await llmAnswer(env, q);
      if (a) return a + '\n\n_Still stuck? Open a ticket in **#support**._';
    } catch { /* fall back to curated */ }
  }
  return curatedAnswer(q);
}

function getQuestionOption(data) {
  const o = (data.data?.options || []).find((x) => x.name === 'question');
  return o?.value || '';
}

// Deferred: /ask can call an LLM (>3s), so ack first then edit @original.
export async function handleAskDeferred(data, env) {
  const question = getQuestionOption(data);
  let content;
  try { content = await answerQuestion(env, question); }
  catch { content = 'Sorry, I hit a snag. Please open a ticket in **#support**.'; }
  const appId = env.DISCORD_APP_ID;
  const token = data.token;
  if (!appId || !token) return;
  await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }).catch(() => {});
}

// Inline fallback if ctx isn't available (curated only, to stay under 3s).
export async function handleAskInline(data, env) {
  return { type: 4, data: { content: curatedAnswer(getQuestionOption(data)), flags: FLAG_EPHEMERAL } };
}
