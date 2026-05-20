// Build a Discord embed for a product announcement. Mirrors the shape of
// the Node version (src/embed.js) but takes the product config in directly
// since the Worker doesn't have a global products singleton.

const MAX_DESCRIPTION = 4096;
const MAX_FIELD_VALUE = 1024;

export function buildAnnouncementEmbed({ product, title, body, url, kind, productCfg, footer }) {
  const cfg = productCfg || { displayName: product || 'aquilo.gg', color: 0x3A86FF, emoji: '✨' };
  const description = (body || '').slice(0, MAX_DESCRIPTION);
  const heading = (cfg.emoji ? cfg.emoji + ' ' : '') + (title || 'Update');

  const embed = {
    color:       cfg.color,
    title:       heading.slice(0, 256),
    description,
    timestamp:   new Date().toISOString()
  };
  if (url) embed.url = url;
  if (cfg.displayName) {
    embed.author = { name: cfg.displayName, url: cfg.homepage || undefined };
  }
  if (kind) {
    embed.fields = [{ name: 'Kind', value: String(kind).slice(0, MAX_FIELD_VALUE), inline: true }];
  }
  embed.footer = { text: footer || ('aquilo.gg · ' + cfg.displayName) };
  return embed;
}
