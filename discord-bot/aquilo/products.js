// Per-product configuration. Reads from the PRODUCTS env var (JSON
// string), falling back to baked-in defaults. Same shape as the Node
// version's src/products.js so the migration is drop-in.
//
// Workers don't have process.env, vars come in via the env binding
// argument from fetch(). We accept it explicitly.

const DEFAULT_PRODUCTS = {
  loadout: {
    displayName: 'Loadout',
    color:       0x3A86FF,
    emoji:       '⚡',
    homepage:    'https://aquilo.gg/loadout',
    repo:        'aquiloplays/loadout'
  },
  streamfusion: {
    displayName: 'StreamFusion',
    color:       0x9147FF,
    emoji:       '💬',
    homepage:    'https://aquilo.gg',
    repo:        'aquiloplays/StreamFusion'
  },
  general: {
    displayName: 'aquilo.gg',
    color:       0xF0B429,
    emoji:       '✨',
    homepage:    'https://aquilo.gg'
  }
};

export function getProducts(env) {
  let overrides = {};
  if (env.PRODUCTS) {
    try { overrides = JSON.parse(env.PRODUCTS); }
    catch (e) { /* keep silent on bad JSON; falls back to defaults */ }
  }
  const out = {};
  for (const [key, defaults] of Object.entries(DEFAULT_PRODUCTS)) {
    out[key] = { ...defaults, ...(overrides[key] || {}) };
  }
  for (const [key, ov] of Object.entries(overrides)) {
    if (!out[key]) out[key] = { displayName: key, color: 0x808080, ...ov };
  }
  return out;
}
