/*
 * StreamFusion preload extension for Aquilo Bus events.
 *
 * Merge into the existing StreamFusion preload.js. Adds two surface methods to
 * window.electronAPI:
 *
 *   onAquiloBus(callback)   - subscribe to bus events from the main process
 *   publishAquiloBus(kind, data)  - publish an event back through the main process
 *
 * The renderer never opens a socket itself - keeping the WS connection in main
 * lets us survive renderer reloads and preserves a single shared socket across
 * all SF windows (chat overlay, settings, recap previewer).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', Object.assign(
  // If you already expose other APIs here, spread them in:
  (window.electronAPI || {}),
  {
    onAquiloBus: (callback) => {
      const handler = (_event, msg) => { try { callback(msg); } catch (e) { console.error(e); } };
      ipcRenderer.on('aquilo-bus-event', handler);
      return () => ipcRenderer.removeListener('aquilo-bus-event', handler);
    },
    publishAquiloBus: (kind, data) => ipcRenderer.send('aquilo-bus-publish', { kind, data })
  }
));
