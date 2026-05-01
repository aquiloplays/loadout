using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Loadout.Apex
{
    /// <summary>
    /// Persistent state for the Apex feature: who currently holds the spot,
    /// their HP pool, and the contribution ledger for this reign.
    ///
    /// Reigns are bounded to one champion at a time. When HP hits 0 we close
    /// out the reign (writing it to <see cref="History"/>), pick the finisher
    /// as the new champion, and start a fresh reign.
    /// </summary>
    public sealed class ApexState
    {
        public ApexChampion Current { get; set; }
        public List<ApexReignSummary> History { get; set; } = new List<ApexReignSummary>();
        // Cap history retention so the file doesn't grow unbounded; we keep
        // the last 50 reigns, which is plenty for !apex history queries.
        public const int MaxHistory = 50;
    }

    public sealed class ApexChampion
    {
        // Canonical identity key from IdentityLinker — so a viewer linked
        // across platforms holds the throne consistently.
        public string CanonicalKey { get; set; }
        public string Platform     { get; set; }
        public string Handle       { get; set; }
        public string Display      { get; set; }
        public string ProfileImage { get; set; }   // resolved lazily

        public int      Health      { get; set; }
        public int      MaxHealth   { get; set; }
        public DateTime CrownedUtc  { get; set; }
        public string   CrownedBy   { get; set; }   // "first-blood" | "finisher:<who>" | "mod:<who>"

        public Dictionary<string, ApexContributor> Contributors { get; set; }
            = new Dictionary<string, ApexContributor>(StringComparer.OrdinalIgnoreCase);
    }

    public sealed class ApexContributor
    {
        public string Display      { get; set; }
        public string Platform     { get; set; }
        public int    TotalDamage  { get; set; }
        public int    HitCount     { get; set; }
        public DateTime LastHitUtc { get; set; }
    }

    public sealed class ApexReignSummary
    {
        public string   Champion           { get; set; }
        public string   Platform           { get; set; }
        public DateTime CrownedUtc         { get; set; }
        public DateTime EndedUtc           { get; set; }
        public string   EndedBy            { get; set; }   // finisher's display
        public int      MaxHealth          { get; set; }
        public int      DistinctAttackers  { get; set; }
        public int      TotalDamageDealt   { get; set; }
    }
}
