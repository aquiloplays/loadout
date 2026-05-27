// AI GM — Anthropic API wrapper for the campaign module.
//
// Default model: claude-haiku-4-5-20251001 (Clay 2026-05: prefer
// Haiku for cost; Sonnet is the upgrade path for important beats
// if we add per-call routing later). Token spend is tracked per
// campaign session in D1; calls refuse to fire once cost_cents
// crosses cost_cap_cents.
//
// System prompt is baked verbatim from Clay's spec — em-dash ban,
// 2-4 sentence beats, dry-humored DM voice, real consequences,
// d20 combat with visible rolls. Adventure premise + party
// characters are injected per-call so the GM has context without
// re-uploading the rules every beat.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Haiku 4.5 pricing as of 2026-05 — $1.00 / 1M input tokens,
// $5.00 / 1M output tokens. Conservative; actual published rates
// may be lower. Used only for the per-campaign budget cap; not
// surfaced to players as a precise number.
export const MODEL_DEFAULT = 'claude-haiku-4-5-20251001';
const PRICE_IN_PER_MTOK_CENTS  = 100;   // $1.00 = 100¢
const PRICE_OUT_PER_MTOK_CENTS = 500;   // $5.00 = 500¢

export function estimateCostCents(tokensIn, tokensOut) {
  const inC  = (tokensIn  || 0) * PRICE_IN_PER_MTOK_CENTS  / 1_000_000;
  const outC = (tokensOut || 0) * PRICE_OUT_PER_MTOK_CENTS / 1_000_000;
  return Math.ceil(inC + outC);
}

// Build the system prompt. Voice rules first (Clay's spec verbatim),
// then party/premise context. Anthropic system prompts accept a
// string OR an array of content blocks; we use a string here for
// simplicity. Cacheable across turns within a session if we ever
// move to the structured-cache format.
export function buildSystemPrompt({ partyBlob, premise }) {
  const premiseLine = premise
    ? `Adventure premise: ${premise.title}. ${premise.hook}`
    : 'Adventure premise: a tight one-shot of your choice that fits the party.';
  return [
    `You are an experienced D&D one-shot DM running a session for ${partyBlob ? partyBlob.split('\n\n').length : 'a small'} players.`,
    '',
    'Rules (HARD; do not break):',
    '- Never use em dashes. Use periods, commas, or parentheses instead.',
    '- Be concise. 2 to 4 sentences per narration beat. Not paragraphs.',
    '- No fantasy cliches. No "brave adventurer", no "the dust settles", no fortune-cookie wisdom, no purple prose.',
    '- Dry, slightly dark humor. Treat players like adults.',
    '- NPCs sound like actual people with motives and quirks. Not stock archetypes.',
    '- Failure has real consequences. Do not soft-pedal.',
    '- Resolve combat with d20 rolls against character stats. Show the rolls. Show the math.',
    '- Pick a single beat, then stop. Wait for player input before continuing.',
    '- Never invent character actions. The players drive their characters.',
    '',
    'Party:',
    partyBlob || '_(unknown)_',
    '',
    premiseLine,
  ].join('\n');
}

// Format a player character into a short blob the system prompt
// can ingest. Uses dungeon.js hero shape (className, level, hp,
// atk, def, class). Falls back gracefully when fields are missing.
export function formatCharacter(userId, displayName, hero) {
  if (!hero) {
    return `${displayName} (id ${userId}) — class: unknown, no character sheet on file.`;
  }
  const cls = hero.className || hero.class || 'unclassed';
  const lvl = hero.level || 1;
  const hp  = hero.hp != null ? `${hero.hp}/${hero.maxHp ?? hero.hp}` : 'unknown';
  return `${displayName} (id ${userId}): ${cls} L${lvl}, HP ${hp}, ATK ${hero.atk ?? '?'} / DEF ${hero.def ?? '?'}.`;
}

// Single call. `messages` is the Anthropic-shaped array of
// { role: 'user' | 'assistant', content: string } turns. Returns
// { ok, text, usage: { input_tokens, output_tokens }, costCents }
// or { ok: false, error, status?, body? } on failure. Never throws.
export async function generateBeat(env, { systemPrompt, messages, maxTokens = 600, model = MODEL_DEFAULT }) {
  if (!env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'no-api-key' };
  }
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
      }),
    });
    const bodyText = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch { /* see below */ }
    if (!res.ok) {
      return {
        ok: false,
        error: 'anthropic-' + res.status,
        status: res.status,
        body: bodyText.slice(0, 300),
      };
    }
    const text = (parsed?.content || [])
      .filter(b => b?.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    const usage = parsed?.usage || {};
    const tokensIn  = usage.input_tokens  || 0;
    const tokensOut = usage.output_tokens || 0;
    const costCents = estimateCostCents(tokensIn, tokensOut);
    return {
      ok: true,
      text,
      model: parsed?.model || model,
      usage: { tokensIn, tokensOut },
      costCents,
    };
  } catch (e) {
    return { ok: false, error: 'fetch-failed', detail: e?.message || String(e) };
  }
}
