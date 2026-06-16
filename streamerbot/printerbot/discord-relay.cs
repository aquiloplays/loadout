// PrinterBot - Discord Relay
// Posts the rendered receipt PNG (path picked up from %printedImagePath%
// arg, set by "PrinterBot - Print Receipt") to the Loadout Worker's
// /printerbot/discord-relay endpoint. The Worker fans it out to a
// fixed Discord channel using the bot token already configured there;
// SB itself never sees the bot token. Auth via shared secret in
// x-printerbot-secret header (value = %PRINTERBOT_RELAY_SECRET%
// global var, set once by the operator).
//
// Fail-open: any failure is logged + swallowed so the thermal-print
// pipeline never blocks on a Discord outage.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;

public class CPHInline
{
    public bool Execute()
    {
        try
        {
            string imagePath;
            if (!CPH.TryGetArg("printedImagePath", out imagePath) || string.IsNullOrWhiteSpace(imagePath))
            {
                CPH.LogDebug("[PrinterBot] Discord relay: no printedImagePath, skipping.");
                return true;
            }
            if (!File.Exists(imagePath))
            {
                CPH.LogDebug("[PrinterBot] Discord relay: file missing at " + imagePath);
                return true;
            }

            // Caption: "@viewer sent GiftName" by default. Pull from
            // whatever the upstream trigger gave us (TikFinity uses
            // uniqueId / nickname, Twitch uses user/userName).
            string user = "";
            CPH.TryGetArg("uniqueId", out user);
            if (string.IsNullOrEmpty(user)) CPH.TryGetArg("nickname", out user);
            if (string.IsNullOrEmpty(user)) CPH.TryGetArg("user", out user);
            if (string.IsNullOrEmpty(user)) CPH.TryGetArg("userName", out user);
            if (string.IsNullOrEmpty(user)) user = "viewer";
            string gift;
            if (!CPH.TryGetArg("gift_name", out gift) || string.IsNullOrEmpty(gift)) gift = "a gift";
            string caption = "@" + user + " sent " + gift;

            string relaySecret = (string)CPH.GetGlobalVar<string>("PRINTERBOT_RELAY_SECRET", true);
            if (string.IsNullOrEmpty(relaySecret))
            {
                // Allow per-action arg override too, so the global var
                // can stay unset on test rigs.
                CPH.TryGetArg("PRINTERBOT_RELAY_SECRET", out relaySecret);
            }
            if (string.IsNullOrEmpty(relaySecret))
            {
                CPH.LogWarn("[PrinterBot] Discord relay: PRINTERBOT_RELAY_SECRET not set, skipping.");
                return true;
            }

            string url = (string)CPH.GetGlobalVar<string>("PRINTERBOT_RELAY_URL", true);
            if (string.IsNullOrEmpty(url))
            {
                // Default to the live Worker host. The loadout-discord.aquilo.gg
                // custom domain is not configured (NXDOMAIN), so the canonical
                // reachable endpoint is the workers.dev URL. Operators who set
                // up the custom domain can override via the PRINTERBOT_RELAY_URL
                // global var.
                url = "https://loadout-discord.aquiloplays.workers.dev/printerbot/discord-relay";
            }

            // Build multipart/form-data body by hand. SB ships .NET 4.x
            // so HttpClient is fine but WebRequest keeps the action
            // dependency-free.
            string boundary = "----PrinterBotRelay" + Guid.NewGuid().ToString("N");
            byte[] body;
            using (var ms = new MemoryStream())
            {
                Append(ms, "--" + boundary + "\r\n");
                Append(ms, "Content-Disposition: form-data; name=\"caption\"\r\n\r\n");
                Append(ms, caption + "\r\n");

                Append(ms, "--" + boundary + "\r\n");
                Append(ms, "Content-Disposition: form-data; name=\"image\"; filename=\"" + Path.GetFileName(imagePath) + "\"\r\n");
                Append(ms, "Content-Type: image/png\r\n\r\n");
                ms.Write(File.ReadAllBytes(imagePath), 0, (int)new FileInfo(imagePath).Length);
                Append(ms, "\r\n--" + boundary + "--\r\n");
                body = ms.ToArray();
            }

            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.ContentType = "multipart/form-data; boundary=" + boundary;
            req.Headers["x-printerbot-secret"] = relaySecret;
            req.UserAgent = "loadout-printerbot-sb/1.0";
            req.ContentLength = body.Length;
            using (var rs = req.GetRequestStream()) rs.Write(body, 0, body.Length);
            try
            {
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    CPH.LogDebug("[PrinterBot] Discord relay: " + (int)resp.StatusCode);
                }
            }
            catch (WebException wex)
            {
                // Fail-open: log + move on. Never echo the secret.
                CPH.LogWarn("[PrinterBot] Discord relay HTTP error: " + wex.Message);
            }
        }
        catch (Exception ex)
        {
            CPH.LogWarn("[PrinterBot] Discord relay failed: " + ex.Message);
        }
        return true;
    }

    private static void Append(MemoryStream ms, string s)
    {
        var bytes = Encoding.UTF8.GetBytes(s);
        ms.Write(bytes, 0, bytes.Length);
    }
}
