/*
 * Loadout — All-in-one overlay router.
 *
 * Reads ?layers=… from the URL (CSV), and for every layer name in that
 * list creates an <iframe> pointing at the standalone overlay path,
 * forwarding bus + secret so the iframe's main.js can connect on its
 * own. Layers not in the list stay hidden — their iframes are never
 * created so we don't burn a WebSocket per disabled layer.
 *
 * Per-overlay deep theming (accent / lbRows / etc.) lives on the
 * standalone overlay's URL, not here — the unified overlay only
 * juggles which layers are visible + the shared bus connection.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const bus = params.get('bus') || 'ws://127.0.0.1:7470/aquilo/bus/';
  const secret = params.get('secret') || '';
  const layersParam = params.get('layers') ||
    'bolts,counters,goals,check-in,apex,commands,recap,viewer';
  const enabled = new Set(
    layersParam.split(',').map(s => s.trim()).filter(Boolean)
  );

  document.querySelectorAll('.layer').forEach(el => {
    const name = el.dataset.name;
    if (!enabled.has(name)) {
      el.classList.add('hidden');
      return;
    }
    const baseSrc = el.dataset.src;
    const url = new URL(baseSrc, location.href);
    url.searchParams.set('bus', bus);
    if (secret) url.searchParams.set('secret', secret);
    const iframe = document.createElement('iframe');
    iframe.src = url.toString();
    iframe.setAttribute('allowtransparency', 'true');
    iframe.setAttribute('scrolling', 'no');
    iframe.title = 'Loadout ' + name + ' overlay';
    el.appendChild(iframe);
  });
})();
