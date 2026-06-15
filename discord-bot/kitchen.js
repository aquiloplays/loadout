// Aquilo Kitchen, Clay's personal weekly meal + snack planner.
//
// Owner-only. Mirrors the Knowledge Vault wiring: the site dispatcher
// (functions/api/web/play) verifies Clay's session, stamps _owner:true,
// and HMAC-forwards to /web/admin/kitchen/api; web.js gates with
// ownerCheck(body) before calling handleKitchenApi here.
//
// Recipes are generated via Claude Haiku 4.5 and stored in D1. Each
// week, runWeeklyKitchenPick picks a rotation (7 meals, 5 snacks, 3
// infant-friendly options) and fires ONE push notification through
// the existing /api/push/external bridge. Tap-through opens /kitchen/.
//
// Constraints baked into the generator prompt:
//   under 30 min active time, under 8 ingredients, kid-friendly +
//   recognizable, mild seasoning, under $5/serving target, NO em dashes.
// Infant-friendly recipes call out age windows (6-12mo purees, 12-24mo
// soft finger foods) and choking hazard guidance.

const OWNER_ID = '1107161695262085210'; // Clay's Discord id, only kitchen owner.
const DAY_MS = 86400000;

const RECIPE_TYPES = new Set(['meal', 'snack', 'side', 'infant']);
const COMMON_CUISINES = ['italian', 'mexican', 'american', 'asian', 'mediterranean', 'indian', 'southern'];
const COMMON_PROTEINS = ['chicken', 'beef', 'pork', 'eggs', 'beans', 'tofu', 'fish', 'lentils', 'turkey', 'none'];

function db(env) {
  if (!env || !env.DB) throw new Error('kitchen: no D1 binding (env.DB missing)');
  return env.DB;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
function clampStr(s, n) { return String(s == null ? '' : s).slice(0, n); }
function clampNum(n, lo, hi) { const v = Number(n); if (!Number.isFinite(v)) return lo; return Math.min(hi, Math.max(lo, v)); }
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function newRecipeId(title) { return 'rcp_' + (Math.random().toString(36).slice(2, 6) + Date.now().toString(36)).slice(0, 20); }
async function stableRecipeId(title, type) {
  const h = await sha256Hex(type + '|' + title.toLowerCase().trim());
  return 'rcp_' + h.slice(0, 20);
}

// Strip every em dash the model might smuggle in. en dashes and regular
// hyphens stay. The model is told not to use em dashes; this is the belt.
function scrubEmDash(s) { return String(s == null ? '' : s).replace(/—/g, ', ').replace(/--/g, ', '); }
function scrubObj(o) {
  if (o == null) return o;
  if (typeof o === 'string') return scrubEmDash(o);
  if (Array.isArray(o)) return o.map(scrubObj);
  if (typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o)) out[k] = scrubObj(o[k]);
    return out;
  }
  return o;
}

// ── ISO week key. Sunday-rolling so the Sunday-morning cron produces a
//    fresh week_key every run. Format YYYY-Www (e.g. 2026-W24).
function isoWeekKey(ts) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  // Move to Thursday in current ISO week, ISO-week-of-Thursday rule.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

// ── preferences (KV) ────────────────────────────────────────────────────
// dislikes: array of lowercase ingredient names to avoid
// allergies: array of lowercase allergens to NEVER include
// weeklyMeals / weeklySnacks / weeklyInfant: target counts per week
// pushDayOfWeekUtc: 0..6 (0 = Sunday)
// pushHourUtc: 0..23 (default 14 UTC = 10am ET during EDT, 9am EST)
// infantAgeMonths: 6 / 9 / 12 / 18, drives the infant generation prompt
async function getPrefs(env, userId) {
  let s = null;
  try { s = await env.LOADOUT_BOLTS.get('kitchen:prefs:' + userId, { type: 'json' }); } catch { /* ignore */ }
  return {
    dislikes: Array.isArray(s?.dislikes) ? s.dislikes.slice(0, 40).map((x) => String(x).toLowerCase().slice(0, 40)) : [],
    allergies: Array.isArray(s?.allergies) ? s.allergies.slice(0, 20).map((x) => String(x).toLowerCase().slice(0, 40)) : [],
    weeklyMeals: clampNum(s?.weeklyMeals, 3, 14) || 7,
    weeklySnacks: clampNum(s?.weeklySnacks, 0, 10) || 5,
    weeklyInfant: clampNum(s?.weeklyInfant, 0, 7) || 3,
    pushDayOfWeekUtc: Number.isInteger(s?.pushDayOfWeekUtc) ? clampNum(s.pushDayOfWeekUtc, 0, 6) : 0,
    pushHourUtc: Number.isInteger(s?.pushHourUtc) ? clampNum(s.pushHourUtc, 0, 23) : 14,
    infantAgeMonths: clampNum(s?.infantAgeMonths, 6, 36) || 12,
    pickyFocus: s?.pickyFocus !== false, // default true
  };
}
async function setPrefs(env, userId, patch) {
  const cur = await getPrefs(env, userId);
  const next = {
    dislikes: Array.isArray(patch?.dislikes) ? patch.dislikes.slice(0, 40).map((x) => String(x).toLowerCase().slice(0, 40)) : cur.dislikes,
    allergies: Array.isArray(patch?.allergies) ? patch.allergies.slice(0, 20).map((x) => String(x).toLowerCase().slice(0, 40)) : cur.allergies,
    weeklyMeals: Number.isFinite(Number(patch?.weeklyMeals)) ? clampNum(patch.weeklyMeals, 3, 14) : cur.weeklyMeals,
    weeklySnacks: Number.isFinite(Number(patch?.weeklySnacks)) ? clampNum(patch.weeklySnacks, 0, 10) : cur.weeklySnacks,
    weeklyInfant: Number.isFinite(Number(patch?.weeklyInfant)) ? clampNum(patch.weeklyInfant, 0, 7) : cur.weeklyInfant,
    pushDayOfWeekUtc: Number.isInteger(patch?.pushDayOfWeekUtc) ? clampNum(patch.pushDayOfWeekUtc, 0, 6) : cur.pushDayOfWeekUtc,
    pushHourUtc: Number.isInteger(patch?.pushHourUtc) ? clampNum(patch.pushHourUtc, 0, 23) : cur.pushHourUtc,
    infantAgeMonths: Number.isFinite(Number(patch?.infantAgeMonths)) ? clampNum(patch.infantAgeMonths, 6, 36) : cur.infantAgeMonths,
    pickyFocus: typeof patch?.pickyFocus === 'boolean' ? patch.pickyFocus : cur.pickyFocus,
  };
  try { await env.LOADOUT_BOLTS.put('kitchen:prefs:' + userId, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

// ── row mappers ─────────────────────────────────────────────────────────
function mapRecipe(r) {
  let ingredients = [];
  let steps = [];
  let tags = [];
  try { ingredients = JSON.parse(r.ingredients_json || '[]'); } catch { ingredients = []; }
  try { steps = JSON.parse(r.steps_json || '[]'); } catch { steps = []; }
  try { tags = JSON.parse(r.tags_json || '[]'); } catch { tags = []; }
  return {
    id: r.id,
    title: r.title,
    type: r.type,
    cuisine: r.cuisine || '',
    protein: r.protein || '',
    ingredients,
    steps,
    prepMin: r.prep_min || 0,
    cookMin: r.cook_min || 0,
    costPerServing: r.cost_estimate_usd || 0,
    servings: r.servings || 0,
    kidFriendly: !!r.kid_friendly,
    infantSafe: !!r.infant_safe,
    infantAgeMonths: r.infant_age_months || null,
    tags,
    notes: r.notes || '',
    pickedCount: r.picked_count || 0,
    lastPushedAt: r.last_pushed_at || null,
  };
}

// ── main owner API ──────────────────────────────────────────────────────
export async function handleKitchenApi(env, body) {
  const userId = String(body?.discordId || '').trim() || OWNER_ID;
  if (userId !== OWNER_ID) return json({ ok: false, error: 'forbidden' }, 403);
  const action = String(body?.action || '').trim();
  try {
    switch (action) {
      case 'this-week':    return await actThisWeek(env, userId);
      case 'recipe':       return await actRecipe(env, userId, body);
      case 'list-recipes': return await actListRecipes(env, userId, body);
      case 'pantry-list':  return await actPantryList(env, userId);
      case 'pantry-add':   return await actPantryAdd(env, userId, body);
      case 'pantry-update':return await actPantryUpdate(env, userId, body);
      case 'pantry-delete':return await actPantryDelete(env, userId, body);
      case 'grocery-list': return await actGroceryList(env, userId);
      case 'generate-week':return await actGenerateWeek(env, userId, body);
      case 'pick-week':    return await actPickWeek(env, userId, body);
      case 'seed-library': return await actSeedLibrary(env, userId, body);
      case 'prefs-get':    return json({ ok: true, prefs: await getPrefs(env, userId) });
      case 'prefs-set':    return json({ ok: true, prefs: await setPrefs(env, userId, body) });
      case 'stats':        return await actStats(env, userId);
      default:             return json({ ok: false, error: 'unknown-action' }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 500);
  }
}

// ── this-week dashboard read ────────────────────────────────────────────
async function actThisWeek(env, userId) {
  const week = isoWeekKey(Date.now());
  const pick = await db(env).prepare(
    `SELECT * FROM kitchen_picks WHERE user_id = ? AND week_key = ? ORDER BY picked_at DESC LIMIT 1`
  ).bind(userId, week).first();
  if (!pick) return json({ ok: true, week, meals: [], snacks: [], infant: [], totalCost: 0, generatedThisWeek: false });
  const ids = [].concat(
    safeJsonArray(pick.meal_ids_json),
    safeJsonArray(pick.snack_ids_json),
    safeJsonArray(pick.infant_ids_json),
  );
  if (!ids.length) return json({ ok: true, week, meals: [], snacks: [], infant: [], totalCost: 0, generatedThisWeek: true });
  const recipes = await fetchRecipesByIds(env, userId, ids);
  const map = new Map(recipes.map((r) => [r.id, r]));
  const meals = safeJsonArray(pick.meal_ids_json).map((id) => map.get(id)).filter(Boolean);
  const snacks = safeJsonArray(pick.snack_ids_json).map((id) => map.get(id)).filter(Boolean);
  const infant = safeJsonArray(pick.infant_ids_json).map((id) => map.get(id)).filter(Boolean);
  return json({ ok: true, week, meals, snacks, infant, totalCost: pick.total_cost_usd || 0, generatedThisWeek: true, pickedAt: pick.picked_at, pushedAt: pick.pushed_at });
}
function safeJsonArray(s) { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
async function fetchRecipesByIds(env, userId, ids) {
  if (!ids.length) return [];
  const uniq = [...new Set(ids)];
  const placeholders = uniq.map(() => '?').join(',');
  const r = await db(env).prepare(
    `SELECT * FROM kitchen_recipes WHERE user_id = ? AND id IN (${placeholders})`
  ).bind(userId, ...uniq).all();
  return (r?.results || []).map(mapRecipe);
}

// ── single recipe read ──────────────────────────────────────────────────
async function actRecipe(env, userId, body) {
  const id = clampStr(body?.id, 60);
  if (!id) return json({ ok: false, error: 'missing-id' }, 400);
  const r = await db(env).prepare(`SELECT * FROM kitchen_recipes WHERE id = ? AND user_id = ?`).bind(id, userId).first();
  if (!r) return json({ ok: false, error: 'not-found' }, 404);
  return json({ ok: true, recipe: mapRecipe(r) });
}

// ── recipe library browse ──────────────────────────────────────────────
async function actListRecipes(env, userId, body) {
  const type = RECIPE_TYPES.has(body?.type) ? body.type : null;
  const limit = clampNum(body?.limit, 1, 200) || 60;
  let r;
  if (type) {
    r = await db(env).prepare(
      `SELECT * FROM kitchen_recipes WHERE user_id = ? AND type = ? ORDER BY generated_at DESC LIMIT ?`
    ).bind(userId, type, limit).all();
  } else {
    r = await db(env).prepare(
      `SELECT * FROM kitchen_recipes WHERE user_id = ? ORDER BY generated_at DESC LIMIT ?`
    ).bind(userId, limit).all();
  }
  return json({ ok: true, recipes: (r?.results || []).map(mapRecipe) });
}

// ── pantry CRUD ─────────────────────────────────────────────────────────
async function actPantryList(env, userId) {
  const r = await db(env).prepare(
    `SELECT * FROM kitchen_pantry WHERE user_id = ? ORDER BY added_at DESC`
  ).bind(userId).all();
  return json({ ok: true, items: (r?.results || []).map((p) => ({
    id: p.id,
    ingredient: p.ingredient,
    displayName: p.display_name || p.ingredient,
    qty: p.qty,
    unit: p.unit,
    expiry: p.expiry,
    addedAt: p.added_at,
  })) });
}
async function actPantryAdd(env, userId, body) {
  const display = clampStr(body?.ingredient, 80).trim();
  if (!display) return json({ ok: false, error: 'missing' }, 400);
  const ingredient = display.toLowerCase();
  const qty = body?.qty == null ? null : clampNum(body.qty, 0, 10000);
  const unit = clampStr(body?.unit, 20).trim() || null;
  const expiry = body?.expiry == null ? null : Math.max(0, Number(body.expiry) || 0);
  const id = 'pan_' + (await sha256Hex(userId + '|' + ingredient + '|' + Date.now() + '|' + Math.random())).slice(0, 16);
  await db(env).prepare(
    `INSERT INTO kitchen_pantry (id, user_id, ingredient, display_name, qty, unit, expiry, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, ingredient, display, qty, unit, expiry, Date.now()).run();
  return json({ ok: true, id });
}
async function actPantryUpdate(env, userId, body) {
  const id = clampStr(body?.id, 60);
  if (!id) return json({ ok: false, error: 'missing-id' }, 400);
  const sets = [];
  const binds = [];
  if (typeof body?.qty !== 'undefined') { sets.push('qty = ?'); binds.push(body.qty == null ? null : clampNum(body.qty, 0, 10000)); }
  if (typeof body?.unit !== 'undefined') { sets.push('unit = ?'); binds.push(clampStr(body.unit, 20).trim() || null); }
  if (typeof body?.expiry !== 'undefined') { sets.push('expiry = ?'); binds.push(body.expiry == null ? null : Math.max(0, Number(body.expiry) || 0)); }
  if (!sets.length) return json({ ok: false, error: 'no-fields' }, 400);
  binds.push(id, userId);
  await db(env).prepare(`UPDATE kitchen_pantry SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
  return json({ ok: true });
}
async function actPantryDelete(env, userId, body) {
  const id = clampStr(body?.id, 60);
  if (!id) return json({ ok: false, error: 'missing-id' }, 400);
  await db(env).prepare(`DELETE FROM kitchen_pantry WHERE id = ? AND user_id = ?`).bind(id, userId).run();
  return json({ ok: true });
}

// ── grocery list, this-week recipes minus pantry ────────────────────────
async function actGroceryList(env, userId) {
  const week = isoWeekKey(Date.now());
  const pick = await db(env).prepare(
    `SELECT * FROM kitchen_picks WHERE user_id = ? AND week_key = ? ORDER BY picked_at DESC LIMIT 1`
  ).bind(userId, week).first();
  if (!pick) return json({ ok: true, week, items: [], note: 'No weekly pick yet. Generate one first.' });
  const ids = [].concat(safeJsonArray(pick.meal_ids_json), safeJsonArray(pick.snack_ids_json), safeJsonArray(pick.infant_ids_json));
  const recipes = await fetchRecipesByIds(env, userId, ids);
  const pantry = await db(env).prepare(`SELECT ingredient FROM kitchen_pantry WHERE user_id = ?`).bind(userId).all();
  const onHand = new Set((pantry?.results || []).map((p) => String(p.ingredient || '').toLowerCase()));
  // Aggregate by lowercase ingredient name, sum quantities when units match.
  const buckets = new Map();
  for (const r of recipes) {
    for (const ing of r.ingredients || []) {
      const key = String(ing?.name || '').toLowerCase().trim();
      if (!key) continue;
      if (ing?.pantryStaple && onHand.has(key)) continue; // assume we have staples on hand
      if (onHand.has(key)) continue;
      const unit = String(ing?.unit || '').toLowerCase();
      const compoundKey = key + '|' + unit;
      const prev = buckets.get(compoundKey) || { name: ing.name, unit: ing.unit || '', qty: 0, sources: new Set() };
      const q = Number(ing?.qty);
      if (Number.isFinite(q)) prev.qty += q;
      prev.sources.add(r.title);
      buckets.set(compoundKey, prev);
    }
  }
  const items = [...buckets.values()].map((b) => ({
    name: b.name,
    qty: Math.round(b.qty * 100) / 100,
    unit: b.unit,
    sources: [...b.sources],
  })).sort((a, b) => a.name.localeCompare(b.name));
  return json({ ok: true, week, items, note: items.length ? null : 'Pantry covers everything. Nice.' });
}

// ── stats ──────────────────────────────────────────────────────────────
async function actStats(env, userId) {
  const total = await db(env).prepare(`SELECT COUNT(*) AS n FROM kitchen_recipes WHERE user_id = ?`).bind(userId).first();
  const byType = await db(env).prepare(
    `SELECT type, COUNT(*) AS n FROM kitchen_recipes WHERE user_id = ? GROUP BY type`
  ).bind(userId).all();
  const pantry = await db(env).prepare(`SELECT COUNT(*) AS n FROM kitchen_pantry WHERE user_id = ?`).bind(userId).first();
  const counts = { meal: 0, snack: 0, side: 0, infant: 0 };
  for (const row of (byType?.results || [])) counts[row.type] = row.n;
  return json({ ok: true, stats: {
    total: total?.n || 0,
    meals: counts.meal,
    snacks: counts.snack,
    sides: counts.side,
    infant: counts.infant,
    pantry: pantry?.n || 0,
  } });
}

// ── Haiku generation ────────────────────────────────────────────────────
// The model returns JSON. We parse, scrub em dashes, validate, then insert.
async function callHaikuJson(env, systemPrompt, userPrompt, maxTokens) {
  const key = String(env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new Error('ANTHROPIC_API_KEY missing');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens || 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error('haiku ' + res.status + ': ' + txt.slice(0, 200));
  }
  const j = await res.json();
  let text = (j.content || []).map((c) => c.text || '').join('').trim();
  // Strip ```json fences if present.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    // Try to extract the first JSON array/object.
    const m = text.match(/[\[\{][\s\S]*[\]\}]/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* ignore */ } }
    if (!parsed) throw new Error('haiku-bad-json');
  }
  return scrubObj(parsed);
}

const SYSTEM_PROMPT =
  'You are a recipe generator for a tired parent with picky-eater kids and an infant in the house. ' +
  'Output strict JSON only, no preamble or commentary. ' +
  'NEVER use em dashes (the long dash character). Use commas, periods, or parentheses instead. ' +
  'Every recipe must be:\n' +
  ' 1. Healthy with real nutritional balance (lean protein, vegetables, whole grain or starch).\n' +
  ' 2. Easy: under 30 minutes active time, common kitchen tools only.\n' +
  ' 3. Cheap: under $5 per serving using realistic US grocery prices.\n' +
  ' 4. Simple: under 8 ingredients, simple techniques.\n' +
  ' 5. Mild seasoning and recognizable textures so previously picky eaters and kids will try them.\n' +
  'For infant recipes (age 6 to 24 months), use age-appropriate textures (purees for 6 to 9 mo, soft mashable for 9 to 12 mo, soft finger foods for 12+ mo). ' +
  'No honey under 12 months. No whole nuts, hard raw carrots, or whole grapes for any infant.';

function recipeBatchPrompt(type, count, prefs, ageMonths) {
  const dislikes = prefs.dislikes.length ? 'Avoid these ingredients: ' + prefs.dislikes.join(', ') + '.' : '';
  const allergies = prefs.allergies.length ? 'NEVER include these allergens or anything containing them: ' + prefs.allergies.join(', ') + '.' : '';
  const variety = 'Vary cuisines (italian, mexican, american, asian, mediterranean, indian, southern, etc) and proteins (chicken, eggs, beans, tofu, fish, beef, turkey, lentils). Do not repeat any cuisine or protein more than twice in this batch.';
  const fields = `Return a JSON array of ${count} recipe objects. Each object has fields: title (string), cuisine (string, lowercase), protein (one of: chicken, beef, pork, eggs, beans, tofu, fish, lentils, turkey, none), ingredients (array of {name, qty (number), unit (string), pantryStaple (boolean)}), steps (array of short strings, under 8 steps), prepMin (number), cookMin (number), costPerServing (number, USD), servings (number, usually 4), kidFriendly (boolean, true unless inherently spicy), infantSafe (boolean), infantAgeMonths (number or null), tags (array of short strings), notes (string with a tip for getting picky kids to try it).`;
  if (type === 'meal') {
    return `Generate ${count} dinner-style main meals for a family of 4 with kids and an infant. ${variety} ${dislikes} ${allergies}\nEach recipe must be servings: 4, prepMin + cookMin under 30 total, under 8 ingredients, under $5 per serving. Most should be kidFriendly: true with mild seasoning. ${fields}`;
  }
  if (type === 'snack') {
    return `Generate ${count} healthy snacks suitable for kids and adults. ${variety} ${dislikes} ${allergies}\nUnder 15 minutes total, under 6 ingredients, under $2 per serving. servings: 2 to 4. All should be kidFriendly: true. ${fields}`;
  }
  if (type === 'side') {
    return `Generate ${count} simple vegetable or grain sides. ${variety} ${dislikes} ${allergies}\nUnder 20 minutes total, under 6 ingredients, under $2 per serving. servings: 4. ${fields}`;
  }
  // infant
  const ageGuide = ageMonths <= 9 ? 'Smooth purees and soft mashes.' : ageMonths <= 12 ? 'Soft mashes and lump-tolerant textures.' : 'Soft finger foods and small soft bites.';
  return `Generate ${count} infant-friendly recipes for a baby around ${ageMonths} months old. ${ageGuide} ${dislikes} ${allergies}\nNo honey under 12 months. No whole nuts, hard raw vegetables, whole grapes, or other choking hazards. Each notes string should call out the safe texture and any prep cuts (e.g. "quarter grapes lengthwise"). Set infantSafe: true and infantAgeMonths: ${ageMonths}. servings: 1 to 3. Under 6 ingredients, under 15 minutes total, under $3 per serving. ${fields}`;
}

async function insertRecipes(env, userId, type, items) {
  let inserted = 0;
  let skipped = 0;
  const now = Date.now();
  for (const it of items) {
    try {
      const title = clampStr(it?.title, 200).trim();
      if (!title) { skipped++; continue; }
      const id = await stableRecipeId(title, type);
      const ingredients = Array.isArray(it?.ingredients) ? it.ingredients.slice(0, 12) : [];
      const steps = Array.isArray(it?.steps) ? it.steps.slice(0, 10).map((s) => clampStr(s, 600)) : [];
      const cuisine = clampStr(it?.cuisine, 30).toLowerCase().trim() || null;
      const protein = COMMON_PROTEINS.includes(String(it?.protein || '').toLowerCase()) ? String(it.protein).toLowerCase() : null;
      const prepMin = clampNum(it?.prepMin, 0, 240) || 0;
      const cookMin = clampNum(it?.cookMin, 0, 240) || 0;
      const cost = Number(it?.costPerServing) || 0;
      const servings = clampNum(it?.servings, 1, 12) || (type === 'meal' ? 4 : type === 'snack' ? 2 : 4);
      const kidFriendly = it?.kidFriendly === false ? 0 : 1;
      const infantSafe = type === 'infant' || it?.infantSafe === true ? 1 : 0;
      const infantAge = infantSafe ? clampNum(it?.infantAgeMonths, 6, 36) || 12 : null;
      const tags = Array.isArray(it?.tags) ? it.tags.slice(0, 12).map((t) => clampStr(t, 30)) : [];
      const notes = clampStr(it?.notes, 800);
      const res = await db(env).prepare(
        `INSERT INTO kitchen_recipes
           (id, user_id, title, type, cuisine, protein, ingredients_json, steps_json, prep_min, cook_min, cost_estimate_usd, servings, kid_friendly, infant_safe, infant_age_months, tags_json, notes, generated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ingredients_json = excluded.ingredients_json,
           steps_json = excluded.steps_json,
           cost_estimate_usd = excluded.cost_estimate_usd,
           notes = excluded.notes,
           generated_at = excluded.generated_at`
      ).bind(id, userId, title, type, cuisine, protein, JSON.stringify(ingredients), JSON.stringify(steps), prepMin, cookMin, cost, servings, kidFriendly, infantSafe, infantAge, JSON.stringify(tags), notes, now, now).run();
      if (res?.meta?.changes) inserted++; else skipped++;
    } catch { skipped++; }
  }
  return { inserted, skipped };
}

// ── generate-week (on-demand top-up of the library) ─────────────────────
// Body: { meals?:int, snacks?:int, infant?:int, sides?:int }. Returns the
// counts inserted. Used by the "Generate new week" button + the seed flow.
async function actGenerateWeek(env, userId, body) {
  const prefs = await getPrefs(env, userId);
  const wantMeals = clampNum(body?.meals, 0, 12) || 6;
  const wantSnacks = clampNum(body?.snacks, 0, 10) || 5;
  const wantInfant = clampNum(body?.infant, 0, 8) || 3;
  const wantSides = clampNum(body?.sides, 0, 6) || 0;
  const out = { meals: 0, snacks: 0, infant: 0, sides: 0 };
  if (wantMeals)  out.meals = (await generateAndInsert(env, userId, 'meal', wantMeals, prefs)).inserted;
  if (wantSnacks) out.snacks = (await generateAndInsert(env, userId, 'snack', wantSnacks, prefs)).inserted;
  if (wantInfant) out.infant = (await generateAndInsert(env, userId, 'infant', wantInfant, prefs, prefs.infantAgeMonths)).inserted;
  if (wantSides)  out.sides = (await generateAndInsert(env, userId, 'side', wantSides, prefs)).inserted;
  return json({ ok: true, generated: out });
}
async function generateAndInsert(env, userId, type, count, prefs, ageMonths) {
  const userPrompt = recipeBatchPrompt(type, count, prefs, ageMonths);
  const items = await callHaikuJson(env, SYSTEM_PROMPT, userPrompt, 4000);
  const arr = Array.isArray(items) ? items : [];
  return await insertRecipes(env, userId, type, arr);
}

// ── seed-library, initial bulk seed in chunks to fit token budgets ──────
async function actSeedLibrary(env, userId, body) {
  const prefs = await getPrefs(env, userId);
  const ageMonths = prefs.infantAgeMonths;
  const out = { meals: 0, snacks: 0, infant: 0 };
  // Meals: 40 in 4 batches of 10
  for (let i = 0; i < (body?.mealBatches ?? 4); i++) {
    try { out.meals += (await generateAndInsert(env, userId, 'meal', 10, prefs)).inserted; }
    catch (e) { console.warn('[kitchen] seed meals batch failed', e?.message || e); }
  }
  // Snacks: 30 in 3 batches of 10
  for (let i = 0; i < (body?.snackBatches ?? 3); i++) {
    try { out.snacks += (await generateAndInsert(env, userId, 'snack', 10, prefs)).inserted; }
    catch (e) { console.warn('[kitchen] seed snacks batch failed', e?.message || e); }
  }
  // Infant: 15 in 2 batches (8 + 7)
  for (const n of (body?.infantBatches ?? [8, 7])) {
    try { out.infant += (await generateAndInsert(env, userId, 'infant', n, prefs, ageMonths)).inserted; }
    catch (e) { console.warn('[kitchen] seed infant batch failed', e?.message || e); }
  }
  return json({ ok: true, seeded: out });
}

// ── weekly pick ────────────────────────────────────────────────────────
// Selects 7 meals + 5 snacks + 3 infant (prefs-tunable). Avoids any recipe
// pushed in the last 6 weeks. Enforces 3+ cuisines and no protein more
// than 2x across the meal set. Persists in kitchen_picks; returns the
// pick + a flag for whether anything was inserted (idempotent per week).
async function actPickWeek(env, userId, body) {
  return await runWeeklyKitchenPickInner(env, userId, !!body?.force, false);
}

async function runWeeklyKitchenPickInner(env, userId, force, fromCron) {
  const prefs = await getPrefs(env, userId);
  const week = isoWeekKey(Date.now());
  if (!force) {
    const existing = await db(env).prepare(
      `SELECT * FROM kitchen_picks WHERE user_id = ? AND week_key = ? ORDER BY picked_at DESC LIMIT 1`
    ).bind(userId, week).first();
    if (existing) return json({ ok: true, week, alreadyPicked: true, pushedAt: existing.pushed_at });
  }
  const sixWeeks = Date.now() - 42 * DAY_MS;
  const allMeals = await fetchEligible(env, userId, 'meal', sixWeeks);
  const allSnacks = await fetchEligible(env, userId, 'snack', sixWeeks);
  const allInfant = await fetchEligible(env, userId, 'infant', sixWeeks);
  // If the library is thin, top it up just-in-time. We do this only when
  // a count is below target, generation is expensive.
  const wantMeals = prefs.weeklyMeals;
  const wantSnacks = prefs.weeklySnacks;
  const wantInfant = prefs.weeklyInfant;
  if (allMeals.length < wantMeals * 2) await generateAndInsert(env, userId, 'meal', 8, prefs).catch(() => null);
  if (allSnacks.length < wantSnacks * 2) await generateAndInsert(env, userId, 'snack', 6, prefs).catch(() => null);
  if (allInfant.length < wantInfant * 2) await generateAndInsert(env, userId, 'infant', 6, prefs, prefs.infantAgeMonths).catch(() => null);
  const meals = balanceMeals(await fetchEligible(env, userId, 'meal', sixWeeks), wantMeals);
  const snacks = pickRandom(await fetchEligible(env, userId, 'snack', sixWeeks), wantSnacks);
  const infant = pickRandom(await fetchEligible(env, userId, 'infant', sixWeeks), wantInfant);
  const ids = [...meals.map((r) => r.id), ...snacks.map((r) => r.id), ...infant.map((r) => r.id)];
  if (!ids.length) return json({ ok: false, error: 'empty-library' }, 400);
  const totalCost = [...meals, ...snacks, ...infant].reduce((s, r) => s + (r.costPerServing || 0) * (r.servings || 4), 0);
  const pickId = 'pck_' + week.replace(/-/g, '');
  const now = Date.now();
  await db(env).prepare(
    `INSERT OR REPLACE INTO kitchen_picks
       (id, user_id, week_key, meal_ids_json, snack_ids_json, infant_ids_json, total_cost_usd, picked_at, pushed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    pickId, userId, week,
    JSON.stringify(meals.map((r) => r.id)),
    JSON.stringify(snacks.map((r) => r.id)),
    JSON.stringify(infant.map((r) => r.id)),
    Math.round(totalCost * 100) / 100,
    now, fromCron ? now : null,
  ).run();
  // Stamp last_pushed_at on the chosen recipes so the 6-week filter holds.
  const placeholders = ids.map(() => '?').join(',');
  await db(env).prepare(
    `UPDATE kitchen_recipes SET picked_count = picked_count + 1, last_pushed_at = ? WHERE user_id = ? AND id IN (${placeholders})`
  ).bind(now, userId, ...ids).run();
  let pushed = null;
  if (fromCron) {
    try {
      const { firePush } = await import('./push.js');
      pushed = await firePush(env, {
        kind: 'kitchenWeekly',
        title: "This week's kitchen plan is ready.",
        body: `${meals.length} meals, ${snacks.length} snacks, ${infant.length} infant options.`,
        url: 'https://aquilo.gg/kitchen/',
        audience: { kind: 'user', userIds: [userId] },
      });
    } catch (e) { console.warn('[kitchen] weekly push failed', e?.message || e); }
  }
  return json({ ok: true, week, meals, snacks, infant, totalCost: Math.round(totalCost * 100) / 100, pushed });
}

async function fetchEligible(env, userId, type, notSince) {
  const r = await db(env).prepare(
    `SELECT * FROM kitchen_recipes
      WHERE user_id = ? AND type = ?
        AND (last_pushed_at IS NULL OR last_pushed_at < ?)
      ORDER BY picked_count ASC, generated_at DESC`
  ).bind(userId, type, notSince).all();
  return (r?.results || []).map(mapRecipe);
}

// Enforce: 3+ cuisines, no protein 3+ times, prefer underused recipes.
function balanceMeals(pool, want) {
  if (pool.length <= want) return pool.slice(0, want);
  const out = [];
  const cuisineCount = new Map();
  const proteinCount = new Map();
  // Shuffle the pool (Fisher-Yates) so identical priority slots vary week to week.
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  for (const r of shuffled) {
    if (out.length >= want) break;
    const c = r.cuisine || 'unknown';
    const p = r.protein || 'unknown';
    if ((proteinCount.get(p) || 0) >= 2) continue; // no 3x of the same protein
    if ((cuisineCount.get(c) || 0) >= 3) continue; // no 4x of the same cuisine
    out.push(r);
    cuisineCount.set(c, (cuisineCount.get(c) || 0) + 1);
    proteinCount.set(p, (proteinCount.get(p) || 0) + 1);
  }
  // If we couldn't fill due to constraints, top off with whatever's left.
  if (out.length < want) {
    for (const r of shuffled) {
      if (out.length >= want) break;
      if (!out.includes(r)) out.push(r);
    }
  }
  // Ensure cuisine diversity: if fewer than 3 cuisines, force-swap the most-repeated.
  if (cuisineCount.size < 3 && pool.length > out.length) {
    const remaining = shuffled.filter((r) => !out.includes(r));
    for (const r of remaining) {
      if (cuisineCount.has(r.cuisine || 'unknown')) continue;
      // Find a member of out to evict: the cuisine with the highest count.
      let evictIdx = -1;
      let maxC = 0;
      for (let i = 0; i < out.length; i++) {
        const c = out[i].cuisine || 'unknown';
        if ((cuisineCount.get(c) || 0) > maxC) { maxC = cuisineCount.get(c); evictIdx = i; }
      }
      if (evictIdx >= 0 && maxC > 1) {
        const evicted = out[evictIdx];
        cuisineCount.set(evicted.cuisine || 'unknown', (cuisineCount.get(evicted.cuisine || 'unknown') || 0) - 1);
        out[evictIdx] = r;
        cuisineCount.set(r.cuisine || 'unknown', (cuisineCount.get(r.cuisine || 'unknown') || 0) + 1);
        if (cuisineCount.size >= 3) break;
      }
    }
  }
  return out.slice(0, want);
}

function pickRandom(pool, n) {
  if (pool.length <= n) return pool.slice(0, n);
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  return shuffled.slice(0, n);
}

// ── cron entrypoint, weekly ────────────────────────────────────────────
// Called from worker.js's scheduled() on the minute tick. Self-gates on
// prefs.pushDayOfWeekUtc + pushHourUtc and a per-week sent KV marker, so
// any number of cron firings within the hour still send exactly one push.
export async function runWeeklyKitchenPick(env) {
  const userId = OWNER_ID;
  const prefs = await getPrefs(env, userId);
  const now = new Date();
  if (now.getUTCDay() !== prefs.pushDayOfWeekUtc) return { ok: false, reason: 'not-the-day' };
  if (now.getUTCHours() !== prefs.pushHourUtc) return { ok: false, reason: 'not-the-hour' };
  const week = isoWeekKey(Date.now());
  const sentKey = `kitchen:weekly-sent:${userId}:${week}`;
  let already = null;
  try { already = await env.LOADOUT_BOLTS.get(sentKey); } catch { /* ignore */ }
  if (already) return { ok: false, reason: 'already-sent' };
  // Mark sent first so a push failure can't loop-retry.
  try { await env.LOADOUT_BOLTS.put(sentKey, '1', { expirationTtl: 8 * 24 * 3600 }); } catch { /* ignore */ }
  const res = await runWeeklyKitchenPickInner(env, userId, false, true);
  try {
    const json = await res.clone().json();
    return { ok: !!json?.ok, ...json };
  } catch { return { ok: true }; }
}
