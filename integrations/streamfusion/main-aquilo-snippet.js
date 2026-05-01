/*
 * Snippet to merge into StreamFusion's main.js. Wires aquilo-bus.js into the
 * Electron app so the renderer can subscribe + publish via electronAPI.
 *
 * The fan-out is intentionally aggressive: every SF window gets every event.
 * Renderer-side filtering is fine since we're talking a few dozen events/min
 * at most.
 */
const aquiloBus = require('./aquilo-bus');
const { ipcMain, BrowserWindow } = require('electron');

function startAquiloBridge() {
  aquiloBus.start({
    clientName: 'streamfusion-' + (require('./package.json').version || 'dev'),
    // Subscribe to everything by default; renderer will filter.
    kinds: ['*'],
    onEvent: (msg) => {
      for (const w of BrowserWindow.getAllWindows()) {
        try { w.webContents.send('aquilo-bus-event', msg); } catch {}
      }
    }
  });

  // Renderer publishes via window.electronAPI.publishAquiloBus(...).
  ipcMain.on('aquilo-bus-publish', (_e, payload) => {
    if (!payload || !payload.kind) return;
    aquiloBus.publish(payload.kind, payload.data);
  });

  // SF go-live detection should call this so Loadout (and any future product)
  // can react. Plug into your existing live-state changed hook:
  //
  //   onLiveStateChanged((live, info) => {
  //     aquiloBus.publish('streamfusion.live.changed', { live, ...info });
  //   });
}

module.exports = { startAquiloBridge };
