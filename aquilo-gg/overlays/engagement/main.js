// Aquilo engagement overlay — OBS browser source for the tap-to-cheer
// effect. Connects to the local Aquilo Bus and floats the tapped emote
// up the screen on each cheer.shown event.
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var busUrl = params.get("bus") || "ws://127.0.0.1:7470/aquilo/bus/";
  var stage = document.getElementById("stage");
  var ws = null;
  var backoff = 1000;

  function connect() {
    try {
      ws = new WebSocket(busUrl);
    } catch (e) {
      retry();
      return;
    }
    ws.onopen = function () {
      backoff = 1000;
      ws.send(JSON.stringify({ v: 1, kind: "hello", client: "overlay-engagement" }));
      ws.send(
        JSON.stringify({
          v: 1,
          kind: "subscribe",
          kinds: ["cheer.*"],
        }),
      );
    };
    ws.onmessage = function (e) {
      var msg;
      try {
        msg = JSON.parse(e.data);
      } catch (x) {
        return;
      }
      if (!msg || !msg.kind) return;
      dispatch(msg.kind, msg.data || {});
    };
    ws.onclose = function () {
      ws = null;
      retry();
    };
    ws.onerror = function () {};
  }

  function retry() {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 20000);
  }

  function dispatch(kind, data) {
    if (kind === "cheer.shown") return showCheer(data);
  }

  // ── feature A — tap-to-cheer ─────────────────────────────────────────
  function showCheer(d) {
    var em = document.createElement("div");
    em.className = "cheer-emote";
    // Streamer can supply d.emote as a URL (Twitch emote etc.); fall
    // back to the in-house pixel flame when no emote is provided.
    var src = (d && d.emote && /^(https?:)?\/\//i.test(d.emote)) ? d.emote : "/sprites/ui/icons/glossy/flame.png";
    var img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.className = "ico";   // pixelated rendering for our 16×16 sprite
    var size = (38 + Math.random() * 26);
    em.appendChild(img);
    img.style.width = size + "px";
    img.style.height = size + "px";
    em.style.left = (8 + Math.random() * 84) + "vw";
    em.style.setProperty("--drift", ((Math.random() * 2 - 1) * 12).toFixed(1) + "vw");
    stage.appendChild(em);
    setTimeout(function () {
      em.remove();
    }, 3300);
  }

  connect();
})();
