/*
 * Aquilo Bus client for StreamFusion (Electron main process).
 *
 * Drop this file at StreamFusion/aquilo-bus.js. In main.js:
 *
 *     const aquiloBus = require('./aquilo-bus');
 *     aquiloBus.start({ onEvent: (msg) => {
 *         // forward to renderer if you want chat / overlays / etc. to react
 *         if (mainWindow) mainWindow.webContents.send('aquilo-bus-event', msg);
 *     }});
 *
 *     // To publish an event (e.g. when SF detects go-live):
 *     aquiloBus.publish('streamfusion.live.changed', { live: true, title, game });
 *
 * Renderer side (in any window):
 *
 *     window.electronAPI.onAquiloBus((msg) => {
 *         if (msg.kind === 'counter.updated') refreshCounter(msg.data);
 *     });
 *
 * Lifecycle:
 *   - Reads %APPDATA%\Aquilo\bus-secret.txt at startup. If missing, retries
 *     every 10s until it appears (Loadout creates it on first launch).
 *   - Auto-reconnects with exponential backoff (1s -> 30s).
 *   - Subscribes to all kinds by default; pass { kinds: [...] } to filter.
 *
 * No external deps required if you use Node 18+'s built-in undici WebSocket.
 * If you're on older Node, npm i ws and uncomment the line below.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
// const WebSocket = require('ws');  // uncomment for Node < 18
const WebSocket = (typeof globalThis.WebSocket === 'function') ? globalThis.WebSocket : require('ws');

const BUS_PORT = 7470;
const SECRET_FILE = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Aquilo',
  'bus-secret.txt'
);

let ws = null;
let backoff = 1000;
let opts = { onEvent: null, onConnect: null, onDisconnect: null, kinds: ['*'], clientName: 'streamfusion' };
let stopped = false;
let pendingPublishes = [];     // queued while disconnected, capped to last 100

function readSecret() {
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim() || null; }
  catch { return null; }
}

function start(userOpts) {
  opts = Object.assign(opts, userOpts || {});
  stopped = false;
  connect();
}

function stop() {
  stopped = true;
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
}

function publish(kind, data) {
  const msg = { v: 1, kind, data };
  if (!ws || ws.readyState !== 1) {
    if (pendingPublishes.length >= 100) pendingPublishes.shift();
    pendingPublishes.push(msg);
    return false;
  }
  try { ws.send(JSON.stringify(msg)); return true; }
  catch { return false; }
}

function connect() {
  if (stopped) return;
  const secret = readSecret();
  if (!secret) {
    // No secret yet (Loadout hasn't run). Try again shortly.
    setTimeout(connect, 10000);
    return;
  }

  const url = 'ws://127.0.0.1:' + BUS_PORT + '/aquilo/bus/?secret=' + encodeURIComponent(secret);
  try { ws = new WebSocket(url); }
  catch (e) {
    scheduleReconnect('ctor: ' + e.message);
    return;
  }

  ws.onopen = () => {
    backoff = 1000;
    safeSend({ v: 1, kind: 'hello',     client: opts.clientName });
    safeSend({ v: 1, kind: 'subscribe', kinds: opts.kinds || ['*'] });
    if (opts.onConnect) try { opts.onConnect(); } catch {}
    // Flush queued publishes.
    while (pendingPublishes.length > 0) {
      const m = pendingPublishes.shift();
      safeSend(m);
    }
  };

  ws.onmessage = (e) => {
    let msg = null;
    try { msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString()); }
    catch { return; }
    if (!msg || !msg.kind) return;
    if (opts.onEvent) try { opts.onEvent(msg); } catch (err) {
      console.error('[aquilo-bus] onEvent threw:', err);
    }
  };

  ws.onclose = () => {
    if (opts.onDisconnect) try { opts.onDisconnect(); } catch {}
    ws = null;
    scheduleReconnect('close');
  };

  ws.onerror = () => { /* close handler will reconnect */ };
}

function scheduleReconnect(reason) {
  if (stopped) return;
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

function safeSend(obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

module.exports = { start, stop, publish };
