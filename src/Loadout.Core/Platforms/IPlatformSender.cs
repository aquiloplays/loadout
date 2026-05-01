using Loadout.Settings;

namespace Loadout.Platforms
{
    /// <summary>
    /// Abstraction over CPH so platform sending can be unit-tested
    /// and swapped (mock/real). Implemented by <see cref="CphPlatformSender"/>.
    /// </summary>
    public interface IPlatformSender
    {
        bool IsConnected(PlatformMask platform);
        void Send(PlatformMask platform, string message);
    }
}
