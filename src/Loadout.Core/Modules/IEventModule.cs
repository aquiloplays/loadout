using Loadout.Sb;

namespace Loadout.Modules
{
    /// <summary>
    /// Contract every Loadout module implements. New modules slot in by
    /// adding a single line to <see cref="SbEventDispatcher.RegisterDefaultModules"/>
    /// — no other plumbing required.
    /// </summary>
    public interface IEventModule
    {
        /// <summary>Called for every dispatched event. Implementations should ignore kinds they don't care about.</summary>
        void OnEvent(EventContext ctx);

        /// <summary>Called once a minute (driven by the SB-side timer trigger).</summary>
        void OnTick();
    }
}
