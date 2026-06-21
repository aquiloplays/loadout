// Aquilo Scene Themer - poll + apply.
//
// Hits the worker's /api/scene-themer/active/<broadcaster> endpoint every
// 10 seconds (timer trigger configured at import). Reads { ok, scene,
// group, customOps }, then uses CPH.ObsSetSourceVisibility to show the
// active group inside the configured scene and hide every sibling group
// declared in the bundle. Best-effort, all failures log a warning and
// return false so SB skips the tick without affecting the running stream.
//
// Customize the BROADCASTER and SCENE consts below if you edit this file
// after import. The web builder bakes the right values in by default.

using System;
using System.IO;
using System.Net;
using System.Web.Script.Serialization;

public class CPHInline
{
    private const string Broadcaster = "991099623";    // prodigalttv
    private const string SceneName   = "Game";
    private const string WorkerBase  = "https://loadout-discord.aquiloplays.workers.dev";

    // The full list of source groups the bundle knows about. The active
    // one is shown, all others in this list are hidden. Edit this list to
    // match the OBS source groups inside your Scene.
    private static readonly string[] AllGroups = new string[] {
        "theme_default", "theme_fallout", "theme_elden_ring",
    };

    public bool Execute()
    {
        try
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var url = WorkerBase + "/api/scene-themer/active/" + Broadcaster;
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.Timeout = 5000;
            req.UserAgent = "aquilo-scene-themer-sb/1";

            string body;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var s = resp.GetResponseStream())
            using (var r = new StreamReader(s)) { body = r.ReadToEnd(); }

            var ser = new JavaScriptSerializer();
            var d = ser.Deserialize<System.Collections.Generic.Dictionary<string, object>>(body);
            if (d == null) return false;

            object okObj; d.TryGetValue("ok", out okObj);
            if (okObj == null || !(bool)okObj) return false;

            string scene = SceneName;
            object sceneObj; if (d.TryGetValue("scene", out sceneObj) && sceneObj != null) scene = sceneObj.ToString();
            object groupObj; d.TryGetValue("group", out groupObj);
            string activeGroup = groupObj != null ? groupObj.ToString() : "";

            foreach (string g in AllGroups)
            {
                bool visible = (g == activeGroup);
                try { CPH.ObsSetSourceVisibility(scene, g, visible); }
                catch (Exception ex) { CPH.LogWarn("[aquilo-scene-themer] toggle " + g + ": " + ex.Message); }
            }
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogWarn("[aquilo-scene-themer] poll failed: " + ex.Message);
            return false;
        }
    }
}
