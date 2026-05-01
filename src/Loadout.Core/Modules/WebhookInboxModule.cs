using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Bus;
using Loadout.Patreon;
using Loadout.Sb;
using Loadout.Settings;
using Newtonsoft.Json.Linq;

namespace Loadout.Modules
{
    /// <summary>
    /// HTTP listener that turns external webhooks (Ko-fi, Throne, Patreon,
    /// custom apps) into Aquilo Bus events.
    ///
    /// Binds 127.0.0.1:&lt;port&gt; on first tick (we wait so settings are loaded).
    /// Authenticates via the configured shared secret as either an
    /// <c>X-Loadout-Secret</c> header or a <c>?secret=</c> query param. If no
    /// secret is configured, we listen but log a warning.
    ///
    /// On match, two things happen:
    ///   1. Publishes <c>webhook.received</c> on the bus with path + body.
    ///   2. If the matching <see cref="WebhookMapping"/> has an SbActionId,
    ///      calls <c>CPH.RunAction(actionName)</c> via the bridge so user-
    ///      defined SB actions can react in their preferred way.
    /// </summary>
    public sealed class WebhookInboxModule : IEventModule, IDisposable
    {
        private HttpListener _listener;
        private CancellationTokenSource _cts;
        private bool _started;
        private int _boundPort;

        public void OnEvent(EventContext ctx) { /* not chat-driven */ }

        public void OnTick()
        {
            if (_started) return;
            var s = SettingsManager.Instance.Current;
            if (!s.Modules.WebhookInbox || !s.Webhooks.Enabled) return;
            if (!Entitlements.IsUnlocked(Feature.WebhookInbox)) return;

            try { Start(s); _started = true; }
            catch (Exception ex) { SbBridge.Instance.LogError("[Loadout] Webhook inbox start failed: " + ex.Message); }
        }

        private void Start(LoadoutSettings s)
        {
            _boundPort = Math.Max(1, s.Webhooks.Port);
            _listener = new HttpListener();
            _listener.Prefixes.Add("http://127.0.0.1:" + _boundPort + "/");
            _listener.Start();
            _cts = new CancellationTokenSource();
            _ = Task.Run(() => AcceptLoop(_cts.Token));

            if (string.IsNullOrEmpty(s.Webhooks.SharedSecret))
                SbBridge.Instance.LogWarn("[Loadout] Webhook inbox has no shared secret — only loopback requests are accepted, but consider setting one anyway.");
            SbBridge.Instance.LogInfo("[Loadout] Webhook inbox listening on http://127.0.0.1:" + _boundPort);
        }

        private async Task AcceptLoop(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested && _listener != null && _listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = await _listener.GetContextAsync().ConfigureAwait(false); }
                catch { return; }
                _ = HandleAsync(ctx);
            }
        }

        private async Task HandleAsync(HttpListenerContext ctx)
        {
            try
            {
                var s = SettingsManager.Instance.Current;
                var configuredSecret = s.Webhooks.SharedSecret ?? "";
                var providedHeader = ctx.Request.Headers["X-Loadout-Secret"] ?? "";
                var providedQuery  = ctx.Request.QueryString["secret"]      ?? "";

                if (!string.IsNullOrEmpty(configuredSecret) &&
                    providedHeader != configuredSecret &&
                    providedQuery  != configuredSecret)
                {
                    Respond(ctx, 401, "{\"error\":\"unauthorized\"}");
                    return;
                }

                string body;
                using (var sr = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding ?? Encoding.UTF8))
                    body = await sr.ReadToEndAsync().ConfigureAwait(false);

                var path = ctx.Request.Url.AbsolutePath ?? "/";
                JToken parsed = null;
                try { parsed = JToken.Parse(body); } catch { /* not JSON — pass raw */ }

                AquiloBus.Instance.Publish("webhook.received", new
                {
                    path,
                    method  = ctx.Request.HttpMethod,
                    body    = parsed,
                    raw     = parsed == null ? body : null,
                    headers = HeaderMap(ctx.Request.Headers),
                    ts      = DateTime.UtcNow
                });

                // Optional: invoke a configured SB action.
                foreach (var m in s.Webhooks.Mappings ?? new System.Collections.Generic.List<WebhookMapping>())
                {
                    if (string.Equals(m.Path, path, StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(m.SbActionId))
                    {
                        SbBridge.Instance.RunAction(m.SbActionId);
                        break;
                    }
                }

                Respond(ctx, 200, "{\"ok\":true}");
            }
            catch (Exception ex)
            {
                try { Respond(ctx, 500, "{\"error\":\"" + ex.Message.Replace("\"","'") + "\"}"); } catch { }
            }
        }

        private static System.Collections.Generic.Dictionary<string, string> HeaderMap(System.Collections.Specialized.NameValueCollection h)
        {
            var d = new System.Collections.Generic.Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string key in h.AllKeys ?? new string[0])
            {
                if (string.Equals(key, "X-Loadout-Secret", StringComparison.OrdinalIgnoreCase)) continue;
                d[key] = h[key];
            }
            return d;
        }

        private static void Respond(HttpListenerContext ctx, int status, string json)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            ctx.Response.StatusCode = status;
            ctx.Response.ContentType = "application/json";
            ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
            ctx.Response.OutputStream.Close();
        }

        public void Dispose()
        {
            _cts?.Cancel();
            try { _listener?.Stop(); } catch { }
            _listener = null;
        }
    }
}
