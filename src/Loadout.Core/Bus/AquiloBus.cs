using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Loadout.Bus
{
    /// <summary>
    /// AQUILO BUS — localhost pub/sub WebSocket layer for cross-product comms.
    ///
    /// Loadout hosts the server. Other aquilo.gg products (StreamFusion, future
    /// tools, OBS overlays loaded from aquilo.gg) connect as clients. Anyone
    /// can publish, anyone can subscribe. Subscriptions are kind-filtered with
    /// glob support: "counter.*" matches every counter event.
    ///
    /// Wire format (always JSON, single object per WS frame):
    ///   client → server   {"v":1,"kind":"hello","client":"streamfusion-1.5"}
    ///   server → client   {"v":1,"kind":"hello.ack","server":"loadout-0.1.0"}
    ///   client → server   {"v":1,"kind":"subscribe","kinds":["counter.*"]}
    ///   either direction  {"v":1,"kind":"counter.updated","data":{...}}
    ///
    /// Auth: shared secret at %APPDATA%\Aquilo\bus-secret.txt. Generated on
    /// first run if missing. Clients pass it as ?secret=&lt;value&gt; on the
    /// connect URL. Cross-machine connections are rejected at the listener
    /// (we bind 127.0.0.1 only).
    /// </summary>
    public sealed class AquiloBus : IDisposable
    {
        private const int Port = 7470;
        private const string Path = "/aquilo/bus/";
        private const int ProtocolVersion = 1;

        private static readonly Lazy<AquiloBus> _instance =
            new Lazy<AquiloBus>(() => new AquiloBus(), LazyThreadSafetyMode.ExecutionAndPublication);
        public static AquiloBus Instance => _instance.Value;

        private readonly ConcurrentDictionary<Guid, ClientSession> _clients = new ConcurrentDictionary<Guid, ClientSession>();
        private HttpListener _listener;
        private CancellationTokenSource _cts;
        private string _sharedSecret;
        private string _secretPath;
        private string _serverIdent = "loadout-" + (typeof(AquiloBus).Assembly.GetName().Version?.ToString(3) ?? "0.0.0");

        private AquiloBus() { }

        public bool IsRunning => _listener != null && _listener.IsListening;

        /// <summary>Path that StreamFusion / others read to find the shared secret.</summary>
        public string SecretFilePath => _secretPath;

        // In-process handlers for messages whose <c>kind</c> matches the
        // registered prefix. Used by BoltsModule to handle bolts.spend.request
        // server-side instead of just forwarding it to other subscribers.
        // Returns the response message to send back to the originating client
        // (or null to do default fan-out behavior).
        public delegate BusMessage InProcessHandler(string fromClient, BusMessage incoming);
        private readonly ConcurrentDictionary<string, InProcessHandler> _handlers =
            new ConcurrentDictionary<string, InProcessHandler>();

        /// <summary>
        /// Register an in-process handler for an exact <c>kind</c>. When a
        /// client publishes a message with that kind, the handler runs
        /// server-side and the response is sent back ONLY to that client
        /// (rather than fanned out to all subscribers).
        /// </summary>
        public void RegisterHandler(string kind, InProcessHandler handler)
        {
            if (string.IsNullOrEmpty(kind) || handler == null) return;
            _handlers[kind] = handler;
        }

        public void Start()
        {
            if (IsRunning) return;

            _secretPath = ResolveSecretPath();
            _sharedSecret = LoadOrCreateSecret(_secretPath);

            _listener = new HttpListener();
            _listener.Prefixes.Add($"http://127.0.0.1:{Port}{Path}");
            try { _listener.Start(); }
            catch (HttpListenerException ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] AquiloBus failed to bind: " + ex.Message);
                _listener = null;
                return;
            }

            _cts = new CancellationTokenSource();
            _ = Task.Run(() => AcceptLoop(_cts.Token));
        }

        public void Stop()
        {
            _cts?.Cancel();
            try { _listener?.Stop(); } catch { }
            _listener = null;
            foreach (var c in _clients.Values)
            {
                try { c.Socket.Abort(); } catch { }
            }
            _clients.Clear();
        }

        // -------------------- Public publish API --------------------

        /// <summary>
        /// Broadcast an event to all subscribed clients. Modules call this
        /// instead of touching sockets directly.
        /// </summary>
        public void Publish(string kind, object data = null)
        {
            if (string.IsNullOrEmpty(kind) || !IsRunning) return;
            var msg = new BusMessage { V = ProtocolVersion, Kind = kind, Data = data == null ? null : JToken.FromObject(data) };
            var json = JsonConvert.SerializeObject(msg);
            var bytes = Encoding.UTF8.GetBytes(json);

            foreach (var c in _clients.Values)
            {
                if (!c.Wants(kind)) continue;
                _ = SafeSendAsync(c, bytes);
            }
        }

        // -------------------- Listener --------------------

        private async Task AcceptLoop(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested && _listener != null)
            {
                HttpListenerContext http;
                try { http = await _listener.GetContextAsync().ConfigureAwait(false); }
                catch when (ct.IsCancellationRequested) { return; }
                catch (HttpListenerException) { return; }
                catch (ObjectDisposedException)  { return; }

                _ = HandleAsync(http, ct);
            }
        }

        private async Task HandleAsync(HttpListenerContext http, CancellationToken ct)
        {
            // Auth — check shared secret on the query string.
            var secret = http.Request.QueryString["secret"];
            if (secret != _sharedSecret)
            {
                http.Response.StatusCode = 401;
                http.Response.Close();
                return;
            }

            if (!http.Request.IsWebSocketRequest)
            {
                http.Response.StatusCode = 426;     // Upgrade Required
                http.Response.Close();
                return;
            }

            HttpListenerWebSocketContext wsCtx;
            try { wsCtx = await http.AcceptWebSocketAsync(null).ConfigureAwait(false); }
            catch
            {
                http.Response.StatusCode = 500;
                http.Response.Close();
                return;
            }

            var session = new ClientSession(wsCtx.WebSocket);
            _clients[session.Id] = session;

            try { await PumpAsync(session, ct).ConfigureAwait(false); }
            finally
            {
                _clients.TryRemove(session.Id, out _);
                try { session.Socket.Dispose(); } catch { }
            }
        }

        private async Task PumpAsync(ClientSession s, CancellationToken ct)
        {
            // Greet immediately — clients can rely on hello.ack arriving first.
            await SendJsonAsync(s, new BusMessage
            {
                V = ProtocolVersion,
                Kind = "hello.ack",
                Data = JToken.FromObject(new { server = _serverIdent, time = DateTime.UtcNow })
            }, ct).ConfigureAwait(false);

            var buf = new byte[16 * 1024];
            var ms = new MemoryStream();
            while (s.Socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                ms.SetLength(0);
                WebSocketReceiveResult res;
                do
                {
                    try { res = await s.Socket.ReceiveAsync(new ArraySegment<byte>(buf), ct).ConfigureAwait(false); }
                    catch { return; }
                    if (res.MessageType == WebSocketMessageType.Close)
                    {
                        try { await s.Socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", ct); } catch { }
                        return;
                    }
                    ms.Write(buf, 0, res.Count);
                }
                while (!res.EndOfMessage);

                var json = Encoding.UTF8.GetString(ms.ToArray());
                BusMessage msg;
                try { msg = JsonConvert.DeserializeObject<BusMessage>(json); }
                catch { continue; }
                if (msg == null || string.IsNullOrEmpty(msg.Kind)) continue;

                await OnMessageAsync(s, msg, ct).ConfigureAwait(false);
            }
        }

        private async Task OnMessageAsync(ClientSession s, BusMessage msg, CancellationToken ct)
        {
            switch (msg.Kind)
            {
                case "hello":
                    s.ClientName = (string)msg.Data?["client"] ?? "anonymous";
                    return;

                case "subscribe":
                    var kinds = (msg.Data?["kinds"] as JArray)?.Select(t => (string)t).Where(k => !string.IsNullOrEmpty(k)).ToArray()
                        ?? new[] { "*" };
                    s.SetSubscriptions(kinds);
                    return;

                case "ping":
                    await SendJsonAsync(s, new BusMessage { V = ProtocolVersion, Kind = "pong" }, ct).ConfigureAwait(false);
                    return;

                default:
                    // Server-side handler? Run synchronously, reply to sender only.
                    if (_handlers.TryGetValue(msg.Kind, out var handler))
                    {
                        BusMessage response = null;
                        try { response = handler(s.ClientName ?? "anon", msg); }
                        catch (Exception ex)
                        {
                            response = new BusMessage
                            {
                                V = ProtocolVersion,
                                Kind = msg.Kind + ".error",
                                Data = JToken.FromObject(new { error = ex.Message })
                            };
                        }
                        if (response != null)
                            await SendJsonAsync(s, response, ct).ConfigureAwait(false);
                        return;
                    }

                    // Otherwise fan out from this client to all others.
                    var json = JsonConvert.SerializeObject(msg);
                    var bytes = Encoding.UTF8.GetBytes(json);
                    foreach (var c in _clients.Values)
                    {
                        if (c.Id == s.Id) continue;
                        if (!c.Wants(msg.Kind)) continue;
                        _ = SafeSendAsync(c, bytes);
                    }
                    return;
            }
        }

        private static async Task SafeSendAsync(ClientSession c, byte[] bytes)
        {
            try
            {
                await c.SendLock.WaitAsync().ConfigureAwait(false);
                try
                {
                    if (c.Socket.State != WebSocketState.Open) return;
                    await c.Socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
                }
                finally { c.SendLock.Release(); }
            }
            catch { /* best-effort — bad clients will be reaped on next iteration */ }
        }

        private static async Task SendJsonAsync(ClientSession c, BusMessage msg, CancellationToken ct)
        {
            var bytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(msg));
            try
            {
                await c.SendLock.WaitAsync(ct).ConfigureAwait(false);
                try { await c.Socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct).ConfigureAwait(false); }
                finally { c.SendLock.Release(); }
            }
            catch { }
        }

        // -------------------- Secret management --------------------

        private static string ResolveSecretPath()
        {
            var dir = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "Aquilo");
            Directory.CreateDirectory(dir);
            return System.IO.Path.Combine(dir, "bus-secret.txt");
        }

        private static string LoadOrCreateSecret(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    var existing = File.ReadAllText(path).Trim();
                    if (existing.Length >= 32) return existing;
                }
            }
            catch { /* fall through to regenerate */ }

            var bytes = new byte[24];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            var fresh = Convert.ToBase64String(bytes).Replace("+", "-").Replace("/", "_").TrimEnd('=');
            try { File.WriteAllText(path, fresh); } catch { }
            return fresh;
        }

        public void Dispose() => Stop();
    }

    public sealed class BusMessage
    {
        [JsonProperty("v")]    public int V    { get; set; }
        [JsonProperty("kind")] public string Kind { get; set; }
        [JsonProperty("data")] public JToken Data { get; set; }
    }

    internal sealed class ClientSession
    {
        public Guid Id { get; } = Guid.NewGuid();
        public WebSocket Socket { get; }
        public SemaphoreSlim SendLock { get; } = new SemaphoreSlim(1, 1);
        public string ClientName { get; set; }
        private string[] _patterns = { "*" };

        public ClientSession(WebSocket socket) { Socket = socket; }

        public void SetSubscriptions(string[] kinds)
        {
            _patterns = (kinds == null || kinds.Length == 0) ? new[] { "*" } : kinds;
        }

        public bool Wants(string kind)
        {
            foreach (var p in _patterns)
            {
                if (p == "*") return true;
                if (p == kind) return true;
                if (p.EndsWith(".*", StringComparison.Ordinal))
                {
                    var prefix = p.Substring(0, p.Length - 2);
                    if (kind.StartsWith(prefix + ".", StringComparison.Ordinal) || kind == prefix) return true;
                }
            }
            return false;
        }
    }
}
