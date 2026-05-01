using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Loadout.Settings;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Loadout.Patreon
{
    /// <summary>
    /// Patreon OAuth + entitlement check. Reuses the same Cloudflare Worker
    /// proxy as StreamFusion (campaign 3410750) so a Tier 2/3 supporter is
    /// entitled across both products with one sign-in.
    ///
    /// OAuth flow:
    ///   1. <see cref="StartSignInAsync"/> generates a PKCE state, opens the
    ///      Patreon authorize URL in the user's default browser, and starts a
    ///      loopback HTTP listener on 127.0.0.1.
    ///   2. The browser redirects to /callback with code+state.
    ///   3. We POST code to the Cloudflare Worker, which adds client_secret
    ///      and returns access/refresh tokens.
    ///   4. We GET /identity?include=memberships from Patreon directly with
    ///      the access token, and decide entitlement.
    ///
    /// Background task: reverify every <see cref="RuntimeCheckInterval"/>.
    /// </summary>
    public sealed class PatreonClient : IDisposable
    {
        // Public values, safe to ship in the binary - same as StreamFusion's.
        private const string ClientId       = "tPN89A6Yz_NEpvQIQ2hDXcfCpyrrYha6YsgZ-aUcQP2y8Lcnaxm7-xSY8W3Zn4QO";
        private const string CampaignId     = "3410750";
        private const string Tier2Id        = "28147937";
        private const string Tier3Id        = "28147942";
        private const string TokenProxyUrl  = "https://streamfusion-patreon-proxy.bisherclay.workers.dev/";

        // Owner email is always entitled - lets the creator test EA features
        // without pledging to themselves. Bypass only kicks in AFTER Patreon
        // has confirmed the email belongs to a verified login.
        private const string OwnerEmail = "bisherclay@gmail.com";

        private static readonly int[] LoopbackPorts = { 17823, 17824, 17825 };
        private static readonly string[] Scopes = { "identity", "identity.memberships" };
        private const string PatreonAuthorizeUrl = "https://www.patreon.com/oauth2/authorize";
        private const string PatreonIdentityUrl  = "https://www.patreon.com/api/oauth2/v2/identity";
        private static readonly TimeSpan RuntimeCheckInterval = TimeSpan.FromHours(1);
        private static readonly TimeSpan OfflineGrace = TimeSpan.FromDays(7);

        private static readonly Lazy<PatreonClient> _instance =
            new Lazy<PatreonClient>(() => new PatreonClient(), LazyThreadSafetyMode.ExecutionAndPublication);
        public static PatreonClient Instance => _instance.Value;

        public event EventHandler<PatreonState> StateChanged;

        private readonly HttpClient _http;
        private string _statePath;
        private PatreonState _state;
        private readonly object _gate = new object();
        private Timer _runtimeTimer;

        private PatreonClient()
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            _http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            _http.DefaultRequestHeaders.UserAgent.ParseAdd("Loadout-Patreon/0.1");
        }

        public PatreonState Current
        {
            get { lock (_gate) return _state ?? new PatreonState(); }
        }

        public void Initialize(string dataFolder)
        {
            lock (_gate)
            {
                Directory.CreateDirectory(dataFolder);
                _statePath = Path.Combine(dataFolder, "patreon-state.bin");
                _state = ReadState() ?? new PatreonState();
            }

            // Periodic re-verify while the app runs.
            _runtimeTimer = new Timer(async _ =>
            {
                try { await RefreshEntitlementAsync().ConfigureAwait(false); } catch { }
            }, null, RuntimeCheckInterval, RuntimeCheckInterval);

            // Kick off an initial check if signed in.
            if (Current.SignedIn) _ = RefreshEntitlementAsync();
        }

        // -------------------- OAuth flow --------------------

        /// <summary>
        /// Begins the sign-in flow. Returns the final state when complete.
        /// </summary>
        public async Task<PatreonState> StartSignInAsync(CancellationToken ct = default)
        {
            int port = TryReservePort();
            if (port == 0) throw new InvalidOperationException("Could not bind any of the OAuth loopback ports.");
            var redirect = $"http://127.0.0.1:{port}/callback";
            var stateNonce = NewNonce();

            var authUrl = PatreonAuthorizeUrl
                + "?response_type=code"
                + "&client_id="    + Uri.EscapeDataString(ClientId)
                + "&redirect_uri=" + Uri.EscapeDataString(redirect)
                + "&scope="        + Uri.EscapeDataString(string.Join(" ", Scopes))
                + "&state="        + Uri.EscapeDataString(stateNonce);

            using (var listener = new HttpListener())
            {
                listener.Prefixes.Add($"http://127.0.0.1:{port}/");
                listener.Start();

                try { System.Diagnostics.Process.Start(authUrl); }
                catch { /* if no default browser, the user can still copy the URL from logs */ }

                var ctxTask = listener.GetContextAsync();
                using (ct.Register(() => listener.Stop()))
                {
                    var ctx = await ctxTask.ConfigureAwait(false);
                    var query = ctx.Request.Url.Query;
                    string code = ParseQuery(query, "code");
                    string returnedState = ParseQuery(query, "state");

                    string body;
                    if (string.IsNullOrEmpty(code) || returnedState != stateNonce)
                    {
                        body = HtmlPage("Sign-in failed", "You can close this window and try again from Loadout.");
                        WriteResponse(ctx, body, 400);
                        throw new InvalidOperationException("Patreon sign-in returned no code, or state mismatch.");
                    }

                    body = HtmlPage("Loadout connected to Patreon", "You can close this window. Loadout will pick up your tier automatically.");
                    WriteResponse(ctx, body, 200);
                    listener.Stop();

                    return await ExchangeCodeAsync(code, redirect).ConfigureAwait(false);
                }
            }
        }

        public async Task<PatreonState> RefreshEntitlementAsync()
        {
            var s = Current;
            if (string.IsNullOrEmpty(s.AccessToken)) return s;

            // Refresh token if access expired.
            if (DateTime.UtcNow >= s.AccessExpiresUtc.AddMinutes(-2))
            {
                try { await RefreshAccessTokenAsync(s.RefreshToken).ConfigureAwait(false); }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine("[Loadout] Patreon token refresh failed: " + ex.Message);
                    // Honor offline grace if we still have a recent verification.
                    if ((DateTime.UtcNow - s.LastVerifiedUtc) < OfflineGrace) return s;
                    return MarkSignedOut("token-refresh-failed");
                }
            }

            return await VerifyMembershipAsync().ConfigureAwait(false);
        }

        public PatreonState SignOut()
        {
            lock (_gate)
            {
                _state = new PatreonState { Reason = "signed-out" };
                Persist();
            }
            StateChanged?.Invoke(this, _state);
            return _state;
        }

        // -------------------- Internals --------------------

        private async Task<PatreonState> ExchangeCodeAsync(string code, string redirect)
        {
            var payload = new
            {
                grant_type = "authorization_code",
                code,
                redirect_uri = redirect,
                client_id = ClientId
            };
            var content = new StringContent(JsonConvert.SerializeObject(payload), Encoding.UTF8, "application/json");
            using var resp = await _http.PostAsync(TokenProxyUrl, content).ConfigureAwait(false);
            var body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            resp.EnsureSuccessStatusCode();

            var tok = JObject.Parse(body);
            UpdateTokens(tok);
            return await VerifyMembershipAsync().ConfigureAwait(false);
        }

        private async Task RefreshAccessTokenAsync(string refreshToken)
        {
            var payload = new
            {
                grant_type    = "refresh_token",
                refresh_token = refreshToken,
                client_id     = ClientId
            };
            var content = new StringContent(JsonConvert.SerializeObject(payload), Encoding.UTF8, "application/json");
            using var resp = await _http.PostAsync(TokenProxyUrl, content).ConfigureAwait(false);
            var body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            resp.EnsureSuccessStatusCode();
            UpdateTokens(JObject.Parse(body));
        }

        private void UpdateTokens(JObject tok)
        {
            lock (_gate)
            {
                _state ??= new PatreonState();
                _state.AccessToken      = (string)tok["access_token"];
                _state.RefreshToken     = (string)tok["refresh_token"] ?? _state.RefreshToken;
                var expiresIn           = (int?)tok["expires_in"] ?? 3600;
                _state.AccessExpiresUtc = DateTime.UtcNow.AddSeconds(expiresIn);
                _state.SignedIn         = !string.IsNullOrEmpty(_state.AccessToken);
                Persist();
            }
        }

        private async Task<PatreonState> VerifyMembershipAsync()
        {
            var s = Current;
            if (string.IsNullOrEmpty(s.AccessToken)) return s;

            var url = PatreonIdentityUrl
                + "?include=memberships,memberships.currently_entitled_tiers,memberships.campaign"
                + "&fields%5Buser%5D=full_name,email"
                + "&fields%5Bmember%5D=patron_status,currently_entitled_amount_cents";

            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", s.AccessToken);
            using var resp = await _http.SendAsync(req).ConfigureAwait(false);
            var body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Patreon /identity " + (int)resp.StatusCode + ": " + body);
                if ((DateTime.UtcNow - s.LastVerifiedUtc) < OfflineGrace) return s;
                return MarkSignedOut("identity-failed");
            }

            return ApplyIdentity(JObject.Parse(body));
        }

        /// <summary>
        /// Decide entitlement from a parsed /identity response. Mirrors the
        /// logic in StreamFusion's verifyMembership: tier id wins; falls back
        /// to amount_cents; rejects only declined/former patrons.
        /// </summary>
        private PatreonState ApplyIdentity(JObject identity)
        {
            string fullName = (string)identity.SelectToken("data.attributes.full_name");
            string email    = (string)identity.SelectToken("data.attributes.email");

            string tier = "none";
            string patronStatus = null;
            JArray memberships = (JArray)identity.SelectToken("data.relationships.memberships.data") ?? new JArray();
            JArray included    = (JArray)identity.SelectToken("included") ?? new JArray();

            foreach (var memRef in memberships)
            {
                var memId = (string)memRef["id"];
                var member = included.OfType<JObject>().FirstOrDefault(o =>
                    (string)o["id"] == memId && (string)o["type"] == "member");
                if (member == null) continue;

                var campaignId = (string)member.SelectToken("relationships.campaign.data.id");
                if (campaignId != CampaignId) continue;

                patronStatus = (string)member.SelectToken("attributes.patron_status") ?? patronStatus;
                int cents = (int?)member.SelectToken("attributes.currently_entitled_amount_cents") ?? 0;

                var tiers = (JArray)member.SelectToken("relationships.currently_entitled_tiers.data") ?? new JArray();
                var tierIds = tiers.Select(t => (string)t["id"]).ToList();

                if (tierIds.Contains(Tier3Id))      tier = "tier3";
                else if (tierIds.Contains(Tier2Id)) tier = "tier2";
                else if (tier == "none" && cents >= 1000) tier = "tier3";
                else if (tier == "none" && cents >= 600)  tier = "tier2";
                else if (tier == "none" && cents > 0)     tier = "tier1";
            }

            bool blocked = patronStatus == "declined_patron" || patronStatus == "former_patron";
            bool entitled = !blocked && (tier == "tier2" || tier == "tier3");

            if (!entitled && string.Equals(email, OwnerEmail, StringComparison.OrdinalIgnoreCase))
            {
                tier = "tier3";
                entitled = true;
            }

            lock (_gate)
            {
                _state.UserName        = fullName;
                _state.Email           = email;
                _state.Tier            = tier;
                _state.PatronStatus    = patronStatus;
                _state.Entitled        = entitled;
                _state.LastVerifiedUtc = DateTime.UtcNow;
                _state.Reason          = entitled ? "ok" : (blocked ? "declined" : "tier-too-low");
                Persist();
            }
            StateChanged?.Invoke(this, _state);
            return _state;
        }

        private PatreonState MarkSignedOut(string reason)
        {
            lock (_gate)
            {
                _state.SignedIn = false;
                _state.Entitled = false;
                _state.Reason = reason;
                Persist();
            }
            StateChanged?.Invoke(this, _state);
            return _state;
        }

        // -------------------- Persistence (DPAPI) --------------------

        private void Persist()
        {
            if (string.IsNullOrEmpty(_statePath) || _state == null) return;
            try
            {
                var json = JsonConvert.SerializeObject(_state);
                var raw  = Encoding.UTF8.GetBytes(json);
                var enc  = ProtectedData.Protect(raw, null, DataProtectionScope.CurrentUser);
                File.WriteAllBytes(_statePath, enc);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[Loadout] Patreon persist failed: " + ex.Message);
            }
        }

        private PatreonState ReadState()
        {
            if (string.IsNullOrEmpty(_statePath) || !File.Exists(_statePath)) return null;
            try
            {
                var enc = File.ReadAllBytes(_statePath);
                var raw = ProtectedData.Unprotect(enc, null, DataProtectionScope.CurrentUser);
                return JsonConvert.DeserializeObject<PatreonState>(Encoding.UTF8.GetString(raw));
            }
            catch
            {
                // Either the user moved profiles (DPAPI scope mismatch) or the file
                // is corrupt - either way, force re-auth rather than crash.
                try { File.Delete(_statePath); } catch { }
                return null;
            }
        }

        // -------------------- Loopback / HTML helpers --------------------

        private static int TryReservePort()
        {
            foreach (var p in LoopbackPorts)
            {
                try
                {
                    using var l = new HttpListener();
                    l.Prefixes.Add($"http://127.0.0.1:{p}/test/");
                    l.Start();
                    l.Stop();
                    return p;
                }
                catch { }
            }
            return 0;
        }

        private static string ParseQuery(string queryWithLeadingQ, string key)
        {
            if (string.IsNullOrEmpty(queryWithLeadingQ)) return null;
            var trimmed = queryWithLeadingQ.StartsWith("?") ? queryWithLeadingQ.Substring(1) : queryWithLeadingQ;
            foreach (var pair in trimmed.Split('&'))
            {
                var eq = pair.IndexOf('=');
                if (eq <= 0) continue;
                var k = Uri.UnescapeDataString(pair.Substring(0, eq));
                if (k == key) return Uri.UnescapeDataString(pair.Substring(eq + 1));
            }
            return null;
        }

        private static void WriteResponse(HttpListenerContext ctx, string html, int status)
        {
            var bytes = Encoding.UTF8.GetBytes(html);
            ctx.Response.StatusCode = status;
            ctx.Response.ContentType = "text/html; charset=utf-8";
            ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
            ctx.Response.OutputStream.Close();
        }

        private static string HtmlPage(string title, string body) =>
            "<!doctype html><html><head><meta charset=utf-8><title>" + title + "</title>" +
            "<style>body{background:#0E0E10;color:#EFEFF1;font-family:Segoe UI,system-ui,sans-serif;" +
            "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}" +
            ".card{background:#18181B;border:1px solid #2A2A30;border-radius:12px;padding:32px;max-width:420px;text-align:center}" +
            "h1{margin:0 0 12px;font-size:22px;color:#3A86FF}p{margin:0;color:#ADADB8}</style></head>" +
            "<body><div class=card><h1>" + title + "</h1><p>" + body + "</p></div></body></html>";

        private static string NewNonce()
        {
            var bytes = new byte[16];
            using var rng = RandomNumberGenerator.Create();
            rng.GetBytes(bytes);
            return Convert.ToBase64String(bytes).Replace("+", "-").Replace("/", "_").TrimEnd('=');
        }

        public void Dispose()
        {
            _runtimeTimer?.Dispose();
            _http?.Dispose();
        }
    }
}
