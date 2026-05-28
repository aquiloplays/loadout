// /admin card-art remix — Clay's fix-up loop for the auto-backfill.
//
// Flow:
//   1. Operator runs /admin card-art remix card-id:<cardId>
//   2. Worker calls Giphy with the same rerank logic as the backfill
//      but pulls TOP_N=5 candidates and presents them in an ephemeral
//      message with 5 embed thumbnails + a select menu.
//   3. Operator picks one. The chosen URL becomes the new
//      global-card-art:<cardId> record.
//
// The 5 candidates are stored under a short-lived KV picker entry
// `card-art-remix:<userId>:<cardId>` so the component callback can
// look up which URL maps to which index.

import { CARDS } from './cards-content.js';
import { suggestArtTerms } from './cards-art-suggest.js';
import { setGlobalArt } from './cards-global-art.js';

const PICKER_PREFIX = 'card-art-remix:';
const PICKER_TTL_SEC = 600;   // 10 min

const GIPHY_LIMIT_PER_TERM = 20;
const GIPHY_RATING         = 'pg';
const MAX_BYTES            = 5_000_000;
const MIN_ASPECT           = 0.4;
const MAX_ASPECT           = 2.5;
const TOP_N                = 5;

const ALLOWED_HOSTS = new Set([
  'media.giphy.com',
  'i.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
]);

function hostAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}

function passesFilters(orig) {
  if (!orig?.url || !hostAllowed(orig.url)) return false;
  const size = parseInt(orig.size || '0', 10) || 0;
  if (size > 0 && size > MAX_BYTES) return false;
  const w = parseInt(orig.width || '0', 10) || 0;
  const h = parseInt(orig.height || '0', 10) || 0;
  if (w > 0 && h > 0) {
    const ratio = h / w;
    if (ratio < MIN_ASPECT || ratio > MAX_ASPECT) return false;
  }
  return true;
}

// Same rank-longest-first as card-art-backfill.js — keep these in
// sync so the candidates Clay sees match the auto-backfill's term
// preference.
function rerankForRemix(terms) {
  return [...terms].sort((a, b) => {
    const aw = a.split(/\s+/).length;
    const bw = b.split(/\s+/).length;
    if (aw !== bw) return bw - aw;
    return b.length - a.length;
  });
}

async function giphySearch(apiKey, term) {
  const url = new URL('https://api.giphy.com/v1/gifs/search');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('q',       term);
  url.searchParams.set('limit',   String(GIPHY_LIMIT_PER_TERM));
  url.searchParams.set('rating',  GIPHY_RATING);
  url.searchParams.set('lang',    'en');
  const resp = await fetch(url.toString());
  if (!resp.ok) return null;
  try { return await resp.json(); } catch { return null; }
}

// Collect up to TOP_N usable candidates by walking the ranked search
// terms. Dedups by URL so we don't surface the same GIF from multiple
// terms.
async function gatherCandidates(apiKey, cardId) {
  const suggestion = suggestArtTerms(cardId);
  if (!suggestion.ok || !suggestion.searchTerms?.length) return [];
  const ranked = rerankForRemix(suggestion.searchTerms);
  const seen = new Set();
  const out = [];
  for (const term of ranked) {
    if (out.length >= TOP_N) break;
    const j = await giphySearch(apiKey, term);
    const data = Array.isArray(j?.data) ? j.data : [];
    for (const g of data) {
      if (out.length >= TOP_N) break;
      const orig = g?.images?.original;
      if (!orig?.url || seen.has(orig.url)) continue;
      if (!passesFilters(orig)) continue;
      seen.add(orig.url);
      out.push({
        url:           orig.url,
        contentLength: parseInt(orig.size || '0', 10) || null,
        width:         parseInt(orig.width  || '0', 10) || null,
        height:        parseInt(orig.height || '0', 10) || null,
        title:         g.title || null,
        searchTerm:    term,
      });
    }
  }
  return out;
}

// Slash entry point — interaction.data.options[].options[].value
// path: admin → card-art (group) → remix (sub) → card-id (string).
//
// Returns a Discord interaction response payload (deferred handler
// updates via webhook).
export async function handleCardArtRemixCommand(env, interaction) {
  if (!env.GIPHY_API_KEY) {
    return ephemeral('GIPHY_API_KEY is not set on the worker. Cannot remix.');
  }
  const userId = interaction?.member?.user?.id || interaction?.user?.id;
  if (!userId) return ephemeral('No user id on interaction.');

  // Find the card-id option.
  const cardId = extractOption(interaction, 'card-id');
  if (!cardId) return ephemeral('Missing card-id option.');
  const card = CARDS[cardId];
  if (!card) return ephemeral(`Unknown cardId: \`${cardId}\``);

  const candidates = await gatherCandidates(env.GIPHY_API_KEY, cardId);
  if (!candidates.length) {
    return ephemeral(`No Giphy candidates found for **${card.name}** (\`${cardId}\`).`);
  }

  // Stash candidates under a TTL'd KV picker entry so the component
  // callback can map the chosen index → URL.
  await env.LOADOUT_BOLTS.put(
    `${PICKER_PREFIX}${userId}:${cardId}`,
    JSON.stringify({ candidates, cardName: card.name, createdAt: Date.now() }),
    { expirationTtl: PICKER_TTL_SEC },
  );

  return {
    type: 4,   // CHANNEL_MESSAGE_WITH_SOURCE
    data: {
      flags: 64,   // EPHEMERAL
      content: `Remix candidates for **${card.name}** (\`${cardId}\`). Pick one:`,
      embeds: candidates.slice(0, 10).map((c, i) => ({
        title: `Candidate ${i + 1} — “${c.searchTerm}”`,
        image: { url: c.url },
        footer: { text: c.title ? c.title.slice(0, 120) : '' },
        color: 0x9b6cff,
      })),
      components: [
        {
          type: 1,   // ACTION_ROW
          components: [
            {
              type: 3,   // SELECT_MENU
              custom_id: `ca:rmx:pick:${cardId}`,
              placeholder: 'Pick a candidate',
              min_values: 1, max_values: 1,
              options: candidates.map((c, i) => ({
                label: `Candidate ${i + 1} — ${c.searchTerm}`.slice(0, 100),
                value: String(i),
                description: (c.title || c.url.split('/').pop() || '').slice(0, 100),
              })),
            },
          ],
        },
      ],
    },
  };
}

// Component callback for the select menu. interaction.data.values[0]
// is the chosen candidate index as a string. interaction.data.custom_id
// is `ca:rmx:pick:<cardId>`.
export async function handleCardArtRemixSelect(env, interaction) {
  const userId = interaction?.member?.user?.id || interaction?.user?.id;
  if (!userId) return ephemeral('No user id on interaction.');
  const cid = String(interaction?.data?.custom_id || '');
  const cardId = cid.startsWith('ca:rmx:pick:') ? cid.slice('ca:rmx:pick:'.length) : '';
  if (!cardId) return ephemeral('Bad picker callback.');
  const pickerKey = `${PICKER_PREFIX}${userId}:${cardId}`;
  const picker = await env.LOADOUT_BOLTS.get(pickerKey, { type: 'json' });
  if (!picker?.candidates?.length) {
    return ephemeral('That picker expired. Run `/admin card-art remix` again.');
  }
  const idx = parseInt(interaction?.data?.values?.[0] || '0', 10);
  const chosen = picker.candidates[idx];
  if (!chosen?.url) return ephemeral('Bad candidate index.');

  const r = await setGlobalArt(env, cardId, {
    url:           chosen.url,
    searchTerm:    chosen.searchTerm,
    source:        'manual-remix',
    contentLength: chosen.contentLength,
  });
  if (!r.ok) {
    return ephemeral(`Failed to set global art: \`${r.error}\``);
  }
  // Consume the picker.
  await env.LOADOUT_BOLTS.delete(pickerKey);
  return {
    type: 7,   // UPDATE_MESSAGE (replaces the ephemeral picker)
    data: {
      flags: 64,
      content:
        `✅ Updated global art for **${picker.cardName}** (\`${cardId}\`)\n` +
        `Term: \`${chosen.searchTerm}\` · URL: ${chosen.url}`,
      embeds: [{ image: { url: chosen.url }, color: 0x42c97a }],
      components: [],
    },
  };
}

function ephemeral(text) {
  return { type: 4, data: { flags: 64, content: text } };
}

function extractOption(interaction, name) {
  // Walk the options tree until we find one with this name.
  function walk(opts) {
    if (!Array.isArray(opts)) return undefined;
    for (const o of opts) {
      if (o.name === name && o.value != null) return String(o.value);
      const inner = walk(o.options);
      if (inner != null) return inner;
    }
    return undefined;
  }
  return walk(interaction?.data?.options);
}
