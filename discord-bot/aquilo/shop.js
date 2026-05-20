// Discord-side Bolts shop. Streamer adds items via the admin hub
// "🛍️ Edit Shop" modal; viewers run /shop (or the hub button) to see
// items and buy them. Purchases ledger lives in `shop_purchases`;
// streamer fulfills via the /hub "📦 Fulfill Purchases" button.
//
// Bolts deduction goes through Loadout via its existing
// bolts.spend.request bus protocol — exposed here as
// POST {LOADOUT_BOLT_API_BASE}/spend with the standard secret header.
//
// Public API:
//   handleShopCommand(data, env)         -> show catalogue
//   handleShopBuyClick(env, data)        -> buy item
//   shopEditModal()                      -> hub modal: add item
//   handleShopEditSubmit(env, data)      -> save item
//   listPendingPurchases(env, guildId)   -> for fulfill view

import {
  chat, ephemeral, postChannelMessage, FLAG_EPHEMERAL,
  modal, getModalField, btn, row, BTN_PRIMARY, BTN_SUCCESS,
  COLOR_QUEUE
} from './util.js';
import { bumpAndAnnounce } from './achievements.js';

const SHOP_TITLE = '🛍️ Aquilo Bolts Shop';

export async function handleShopCommand(data, env) {
  if (!env?.DB || !data.guild_id) return ephemeral('Shop not configured.');
  const items = await env.DB.prepare(
    'SELECT id, slug, label, description, price, stock FROM shop_items WHERE guild_id = ? AND active = 1 ORDER BY price ASC'
  ).bind(data.guild_id).all();
  const rows = items.results || [];

  if (rows.length === 0) {
    return chat({
      embeds: [{
        color: COLOR_QUEUE,
        title: SHOP_TITLE,
        description: '_The shop is empty right now — check back after the streamer restocks._'
      }],
      flags: FLAG_EPHEMERAL,
    });
  }

  const lines = rows.map(r => {
    const stockTag = r.stock == null ? '' :
                     r.stock <= 0     ? ' _(sold out)_' :
                                        ` _(${r.stock} left)_`;
    const desc = r.description ? `\n_${r.description}_` : '';
    return `**${r.label}** — ⚡ **${r.price}** Bolts${stockTag}${desc}`;
  });

  const components = chunkButtons(rows.filter(r => r.stock == null || r.stock > 0));

  return chat({
    embeds: [{
      color: COLOR_QUEUE,
      title: SHOP_TITLE,
      description: lines.join('\n\n').slice(0, 4000),
      footer: { text: 'Click a button to spend Bolts. Fulfillment within 24h.' }
    }],
    components,
    flags: FLAG_EPHEMERAL,
  });
}

function chunkButtons(items) {
  const out = [];
  for (let i = 0; i < items.length && out.length < 5; i += 5) {
    const slice = items.slice(i, i + 5);
    out.push(row(...slice.map(it =>
      btn('shop:buy:' + it.id, `${it.label.slice(0, 20)} (${it.price})`,
          { style: BTN_PRIMARY, emoji: '⚡' })
    )));
  }
  return out;
}

export async function handleShopBuyClick(env, data) {
  const id = data?.data?.custom_id || '';
  const itemId = parseInt(id.split(':')[2], 10);
  if (!itemId) return ephemeral('Bad item id.');
  const userId = data?.member?.user?.id || data?.user?.id;

  const item = await env.DB.prepare(
    'SELECT id, label, price, stock, active FROM shop_items WHERE id = ? AND guild_id = ?'
  ).bind(itemId, data.guild_id).first();
  if (!item || !item.active) return ephemeral('That item is no longer available.');
  if (item.stock != null && item.stock <= 0) return ephemeral('Sold out.');

  // Deduct Bolts via Loadout's spend endpoint. Convention: same secret
  // as award-bolts (LOADOUT_BOLT_API_SECRET); URL is LOADOUT_BOLT_API
  // with /counting/award-bolts swapped for /shop/spend.
  if (!env.LOADOUT_BOLT_API || !env.LOADOUT_BOLT_API_SECRET) {
    return ephemeral('Loadout integration not configured.');
  }
  const spendUrl = env.LOADOUT_BOLT_API.replace(/\/counting\/award-bolts$/, '/shop/spend');

  let spendResult;
  try {
    const resp = await fetch(spendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-loadout-bolt-secret': env.LOADOUT_BOLT_API_SECRET,
      },
      body: JSON.stringify({
        user_id: userId,
        amount: item.price,
        reason: 'shop:' + item.id,
      }),
    });
    spendResult = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return ephemeral(spendResult?.error === 'insufficient_funds'
        ? `❌ Not enough Bolts — you need ⚡ ${item.price}.`
        : '❌ Purchase failed.');
    }
  } catch (e) {
    return ephemeral('❌ Couldn\'t reach Loadout. Try again in a moment.');
  }

  // Record the purchase + decrement stock atomically.
  await env.DB.prepare(
    'INSERT INTO shop_purchases (guild_id, user_id, item_id, bolts_spent) VALUES (?, ?, ?, ?)'
  ).bind(data.guild_id, userId, item.id, item.price).run();

  if (item.stock != null) {
    await env.DB.prepare(
      'UPDATE shop_items SET stock = stock - 1 WHERE id = ?'
    ).bind(item.id).run();
  }

  // Achievements: First Purchase + lifetime spend.
  try { await bumpAndAnnounce(env, data.guild_id, userId, 'first_purchase'); } catch {}
  try { await import('./achievements.js').then(m => m.bump(env, data.guild_id, userId, 'big_spender', item.price)); } catch {}

  // Notify staff for fulfillment.
  if (env.STAFF_HUB_CHANNEL_ID || env.AQUILO_ADMIN_HUB_CHANNEL_ID) {
    const adminCh = env.STAFF_HUB_CHANNEL_ID || env.AQUILO_ADMIN_HUB_CHANNEL_ID;
    try {
      await postChannelMessage(env, adminCh, {
        content: `📦 New purchase — <@${userId}> bought **${item.label}** for ⚡ ${item.price}. Fulfill via \`/hub\` → 📦 Fulfill.`
      });
    } catch {}
  }

  return ephemeral(
    `✅ Purchased **${item.label}** for ⚡ ${item.price}. The streamer will fulfill within 24h — keep an eye on DMs.`
  );
}

// ---- Hub modal: add a shop item ---------------------------------------

export function shopEditModal() {
  return modal('modal:shop_edit', 'Add a shop item', [
    { custom_id: 'slug',        label: 'slug (lowercase, e.g. color_role_24h)', style: 1, required: true,  max_length: 40 },
    { custom_id: 'label',       label: 'Label (what viewers see)',               style: 1, required: true,  max_length: 80 },
    { custom_id: 'description', label: 'Description (1 line)',                  style: 2, required: false, max_length: 200 },
    { custom_id: 'price',       label: 'Price in Bolts',                         style: 1, required: true,  max_length: 8 },
    { custom_id: 'stock',       label: 'Stock (blank = unlimited)',              style: 1, required: false, max_length: 8 },
  ]);
}

export async function handleShopEditSubmit(env, data) {
  const slug  = (getModalField(data, 'slug') || '').trim().toLowerCase();
  const label = (getModalField(data, 'label') || '').trim();
  const desc  = (getModalField(data, 'description') || '').trim() || null;
  const price = parseInt(getModalField(data, 'price'), 10);
  const stockStr = (getModalField(data, 'stock') || '').trim();
  const stock = stockStr === '' ? null : parseInt(stockStr, 10);

  if (!slug || !label) return ephemeral('slug + label required.');
  if (!Number.isFinite(price) || price < 1) return ephemeral('Price must be a positive integer.');
  if (stockStr && (!Number.isFinite(stock) || stock < 0)) return ephemeral('Stock must be a non-negative integer.');

  try {
    await env.DB.prepare(
      `INSERT INTO shop_items (guild_id, slug, label, description, price, stock, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(guild_id, slug) DO UPDATE SET
           label = excluded.label, description = excluded.description,
           price = excluded.price, stock = excluded.stock, active = 1`
    ).bind(data.guild_id, slug, label, desc, price, stock).run();
  } catch (e) {
    return ephemeral('Failed to save: ' + (e?.message || e));
  }

  return ephemeral(`🛍️ Saved **${label}** at ⚡ ${price}. Run \`/shop\` to verify.`);
}

export async function listPendingPurchases(env, guildId) {
  if (!env?.DB || !guildId) return [];
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.bolts_spent, p.bought_at, i.label, i.slug
       FROM shop_purchases p
       JOIN shop_items i ON i.id = p.item_id
       WHERE p.guild_id = ? AND p.fulfilled = 0
       ORDER BY p.bought_at ASC`
  ).bind(guildId).all();
  return results || [];
}
