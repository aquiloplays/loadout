// Aquilo engagement overlay — one OBS browser source for every Tier 2
// on-stream event. Connects to the local Aquilo Bus and dispatches by
// event kind. Handlers are added per feature:
//   cheer.shown       floating tap-to-cheer emote          [feature A]
//   code.dropped      code-drop banner                      [feature B]
//   poll.shown        live poll panel                       [feature C]
//   quiz.shown        quiz panel + reveal                   [feature D]
//   raisehand.picked  "picked!" shout                       [feature E]
//   spotlight.shown   viewer-of-the-hour card               [feature F]
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
          kinds: ["cheer.*", "poll.*", "quiz.*", "code.*", "spotlight.*", "raisehand.*"],
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
    // poll.* / quiz.* / code.* / spotlight.* / raisehand.* handlers are
    // registered by their features as Tier 2 ships.
  }

  // ── feature A — tap-to-cheer ─────────────────────────────────────────
  function showCheer(d) {
    var em = document.createElement("div");
    em.className = "cheer-emote";
    em.textContent = d && d.emote ? d.emote : "🔥";
    em.style.left = (8 + Math.random() * 84) + "vw";
    em.style.fontSize = (38 + Math.random() * 26) + "px";
    em.style.setProperty("--drift", ((Math.random() * 2 - 1) * 12).toFixed(1) + "vw");
    stage.appendChild(em);
    setTimeout(function () {
      em.remove();
    }, 3300);
  }

  connect();
})();
