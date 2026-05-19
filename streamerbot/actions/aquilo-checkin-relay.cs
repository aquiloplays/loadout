using System; using System.Net; using System.Net.WebSockets;
using System.Text; using System.Threading;
public class CPHInline {
  public bool Execute() {
    string token = "73867a92d0db758cd961d030769882deb51ab0d466f5d60d"; // RELAY_TOKEN
    string busSecret = System.IO.File.ReadAllText(
      Environment.ExpandEnvironmentVariables(@"%APPDATA%\Aquilo\bus-secret.txt")).Trim();
    var req = (HttpWebRequest)WebRequest.Create(
      "https://loadout-discord.aquiloplays.workers.dev/relay/pending?for=checkin");
    req.Headers["X-Relay-Token"] = token;
    string body;
    using (var resp = (HttpWebResponse)req.GetResponse())
    using (var sr = new System.IO.StreamReader(resp.GetResponseStream())) body = sr.ReadToEnd();
    var triggers = Newtonsoft.Json.Linq.JObject.Parse(body)["triggers"] as Newtonsoft.Json.Linq.JArray;
    if (triggers == null || triggers.Count == 0) return true;
    var ws = new ClientWebSocket();
    ws.ConnectAsync(new Uri("ws://127.0.0.1:7470/aquilo/bus/?secret=" +
      Uri.EscapeDataString(busSecret)), CancellationToken.None).Wait();
    Send(ws, "{\"v\":1,\"kind\":\"hello\",\"client\":\"aquilo-relay\"}");
    foreach (var t in triggers) {
      var f = new Newtonsoft.Json.Linq.JObject();
      f["v"] = 1; f["kind"] = "checkin.shown"; f["data"] = t;
      Send(ws, f.ToString(Newtonsoft.Json.Formatting.None));
    }
    ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None).Wait();
    return true;
  }
  void Send(ClientWebSocket ws, string m) {
    var b = Encoding.UTF8.GetBytes(m);
    ws.SendAsync(new ArraySegment<byte>(b), WebSocketMessageType.Text, true,
      CancellationToken.None).Wait();
  }
}
