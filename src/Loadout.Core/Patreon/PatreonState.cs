using System;

namespace Loadout.Patreon
{
    /// <summary>
    /// Persisted Patreon entitlement state. Lives in patreon-state.bin alongside
    /// settings.json, DPAPI-encrypted (current-user scope).
    /// </summary>
    public sealed class PatreonState
    {
        public int      SchemaVersion       { get; set; } = 1;
        public string   AccessToken         { get; set; }
        public string   RefreshToken        { get; set; }
        public DateTime AccessExpiresUtc    { get; set; }
        public DateTime LastVerifiedUtc     { get; set; } = DateTime.MinValue;

        public bool     SignedIn            { get; set; }
        public bool     Entitled            { get; set; }
        public string   Tier                { get; set; } = "none";   // tier3 | tier2 | tier1 | follower | none
        public string   PatronStatus        { get; set; }              // raw from Patreon
        public string   UserName            { get; set; }
        public string   Email               { get; set; }
        public string   Reason              { get; set; }              // short status code for UI
    }
}
