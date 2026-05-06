using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Web;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Loadout.Bolts;
using Loadout.Bus;
using Loadout.Discord;
using Loadout.Games;
using Loadout.Identity;
using Loadout.Patreon;
using Loadout.Modules;
using Loadout.Sb;
using Loadout.Settings;
using Loadout.Updates;
using Loadout.Util;
using Microsoft.Win32;

namespace Loadout.UI
{
    public partial class SettingsWindow : Window
    {
        private static SettingsWindow _instance;

        /// <summary>
        /// Singleton accessor — opening Settings repeatedly should focus the existing window
        /// rather than spawn duplicates.
        /// </summary>
        public static SettingsWindow GetOrCreate()
        {
            if (_instance == null || !_instance.IsLoaded)
                _instance = new SettingsWindow();
            return _instance;
        }

        // ObservableCollections back the various DataGrids; mutations are
        // visible in the UI immediately and we copy back to settings on Save.
        private readonly ObservableCollection<Counter>          _counters       = new ObservableCollection<Counter>();
        private readonly ObservableCollection<PatreonSupporter> _supporters     = new ObservableCollection<PatreonSupporter>();
        private readonly ObservableCollection<TimedMessage>     _timers         = new ObservableCollection<TimedMessage>();
        private readonly ObservableCollection<Goal>             _goals          = new ObservableCollection<Goal>();
        private readonly ObservableCollection<WebhookMapping>   _webhooks       = new ObservableCollection<WebhookMapping>();
        private readonly ObservableCollection<CustomCommand>    _customCmds     = new ObservableCollection<CustomCommand>();
        private readonly ObservableCollection<AlertRow>         _alertRows      = new ObservableCollection<AlertRow>();
        private readonly ObservableCollection<GameProfile>      _gameProfiles   = new ObservableCollection<GameProfile>();
        private readonly ObservableCollection<ChannelPointMapping> _channelPoints = new ObservableCollection<ChannelPointMapping>();
        private readonly ObservableCollection<WalletRow>        _wallets        = new ObservableCollection<WalletRow>();
        private readonly ObservableCollection<BoltsShopItem>    _shopItems      = new ObservableCollection<BoltsShopItem>();

        // Plays the window-open fade storyboard from Styles.xaml.
        private void Window_Loaded(object sender, RoutedEventArgs e)
        {
            try
            {
                var sb = (System.Windows.Media.Animation.Storyboard)FindResource("WindowFadeIn");
                if (sb != null) sb.Begin(this);
            }
            catch { Opacity = 1; }
        }

        private SettingsWindow()
        {
            // Each step is wrapped so the error log tells us WHICH bind failed
            // when a user has an old settings.json that's missing a section.
            // InitializeComponent() is the one we ALSO wrap on its own because
            // a malformed BAML resource (rare but possible across SB versions)
            // would otherwise propagate before any Step() can log its name.
            try { InitializeComponent(); }
            catch (Exception ex)
            {
                Util.ErrorLog.Write("SettingsWindow.InitializeComponent", ex);
                throw; // propagate - we can't continue without a built tree
            }

            Step("LoadHeaderLogo",         LoadHeaderLogo);
            EnsureSettingsShape();   // populate any nulls left by old-version JSON
            Step("LoadFromSettings",       LoadFromSettings);
            Step("RefreshVersionLine",     RefreshVersionLine);
            Step("RefreshPendingLinks",    RefreshPendingLinks);
            Step("RefreshPatreonState",    RefreshPatreonState);
            Step("RefreshHeaderPills",     RefreshHeaderPills);
            Step("RefreshStatusChips",     RefreshStatusChips);
            Step("HookEmptyStates",        HookEmptyStates);
            Step("BindHealthTab",          BindHealthTab);
            Step("BindCountersAndCheckIn", BindCountersAndCheckIn);
            Step("BindGamesTab",           BindGamesTab);
            Step("BindOverlaysTab",        BindOverlaysTab);
            Step("BindAlertsTab",          BindAlertsTab);
            Step("BindTimersTab",          BindTimersTab);
            Step("BindGoalsTab",           BindGoalsTab);
            Step("BindWebhooksTab",        BindWebhooksTab);
            Step("BindCustomCommandsTab",  BindCustomCommandsTab);
            Step("BindGameProfilesTab",    BindGameProfilesTab);
            Step("BindChannelPointsTab",   BindChannelPointsTab);
            Step("BindLogTab",             BindLogTab);
            Step("BindDiscordBotTab",      BindDiscordBotTab);
            Step("BindWalletsAndShop",     BindWalletsAndShop);
            Step("BindTuningTab",          BindTuningTab);

            PatreonClient.Instance.StateChanged += OnPatreonStateChanged;
            Closed += (_, __) => {
                PatreonClient.Instance.StateChanged -= OnPatreonStateChanged;
                _instance = null;
            };
        }

        // Tiny helper that lets each binding step log on its own context if it
        // throws. We keep going on failure - one bad section shouldn't lock
        // the user out of the whole window.
        private void Step(string name, Action body)
        {
            try { body(); }
            catch (Exception ex) { Util.ErrorLog.Write("SettingsWindow." + name, ex); }
        }

        // Loads the brand mark from an embedded resource stream. The pack URI
        // form (`pack://application:,,,/Loadout;component/assets/Loadout.png`)
        // would have worked too, except SB hosts the DLL via Assembly.LoadFrom
        // in a process that doesn't own a WPF Application, and pack-URI
        // resolution in that scenario is flaky. Stream-load is reliable - same
        // technique the tray icon uses for the .ico.
        private void LoadHeaderLogo()
        {
            try
            {
                var asm = System.Reflection.Assembly.GetExecutingAssembly();
                using (var s = asm.GetManifestResourceStream("Loadout.assets.Loadout.png"))
                {
                    if (s == null) return;
                    var bmp = new System.Windows.Media.Imaging.BitmapImage();
                    bmp.BeginInit();
                    bmp.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
                    bmp.StreamSource = s;
                    bmp.EndInit();
                    bmp.Freeze();
                    HeaderLogo.Source = bmp;
                }
            }
            catch (Exception ex) { Util.ErrorLog.Write("SettingsWindow.LoadHeaderLogo", ex); }
        }

        // Defensively backfill any root-level config that an older settings.json
        // doesn't have. Newtonsoft normally honors property initializers when a
        // JSON key is missing, but if the saved file was written by a build that
        // emitted `null` for a freshly-added field, the in-memory copy comes back
        // null. We patch here so the bind methods can dot through fields without
        // null-guarding every member access.
        private static void EnsureSettingsShape()
        {
            try
            {
                SettingsManager.Instance.Mutate(s =>
                {
                    if (s.Platforms       == null) s.Platforms       = new PlatformsConfig();
                    if (s.Modules         == null) s.Modules         = new ModulesConfig();
                    if (s.Alerts          == null) s.Alerts          = new AlertsConfig();
                    if (s.Timers          == null) s.Timers          = new TimersConfig();
                    if (s.Discord         == null) s.Discord         = new DiscordConfig();
                    if (s.Discord.Embed   == null) s.Discord.Embed   = new DiscordEmbedConfig();
                    if (s.Twitter         == null) s.Twitter         = new TwitterConfig();
                    if (s.Webhooks        == null) s.Webhooks        = new WebhookConfig();
                    if (s.Webhooks.Mappings == null) s.Webhooks.Mappings = new System.Collections.Generic.List<WebhookMapping>();
                    if (s.Moderation      == null) s.Moderation      = new ModerationConfig();
                    if (s.Welcomes        == null) s.Welcomes        = new WelcomesConfig();
                    if (s.Updates         == null) s.Updates         = new UpdatesConfig();
                    if (s.Counters        == null) s.Counters        = new CountersConfig();
                    if (s.Counters.Counters == null) s.Counters.Counters = new System.Collections.Generic.List<Counter>();
                    if (s.CheckIn         == null) s.CheckIn         = new CheckInConfig();
                    if (s.PatreonSupporters == null) s.PatreonSupporters = new PatreonSupportersConfig();
                    if (s.PatreonSupporters.Supporters == null) s.PatreonSupporters.Supporters = new System.Collections.Generic.List<PatreonSupporter>();
                    if (s.InfoCommands    == null) s.InfoCommands    = new InfoCommandsConfig();
                    if (s.InfoCommands.Custom == null) s.InfoCommands.Custom = new System.Collections.Generic.List<CustomCommand>();
                    if (s.Goals           == null) s.Goals           = new GoalsConfig();
                    if (s.Goals.Goals     == null) s.Goals.Goals     = new System.Collections.Generic.List<Goal>();
                    if (s.VipRotation     == null) s.VipRotation     = new VipRotationConfig();
                    if (s.VipRotation.ExemptHandles == null) s.VipRotation.ExemptHandles = new System.Collections.Generic.List<string>();
                    if (s.Bolts           == null) s.Bolts           = new BoltsConfig();
                    if (s.ChatNoise       == null) s.ChatNoise       = new ChatNoiseConfig();
                    if (s.Apex            == null) s.Apex            = new ApexConfig();
                    if (s.RotationIntegration == null) s.RotationIntegration = new RotationIntegrationConfig();
                    if (s.Clips           == null) s.Clips           = new ClipsConfig();
                    if (s.FollowBatch     == null) s.FollowBatch     = new FollowBatchConfig();
                    if (s.GameProfiles    == null) s.GameProfiles    = new GameProfilesConfig();
                    if (s.GameProfiles.Profiles == null) s.GameProfiles.Profiles = new System.Collections.Generic.List<GameProfile>();
                    if (s.ChannelPoints   == null) s.ChannelPoints   = new ChannelPointsConfig();
                    if (s.ChannelPoints.Mappings == null) s.ChannelPoints.Mappings = new System.Collections.Generic.List<ChannelPointMapping>();
                    if (s.Timers.Messages == null) s.Timers.Messages = new System.Collections.Generic.List<TimedMessage>();

                    // One-shot dedup migration: existing settings files
                    // accumulated duplicate timers / counters / goals from
                    // the old append-on-deserialize bug. Collapse identical
                    // entries to one (Name + Message for timers; Name for
                    // counters; Name + Kind for goals). Safe — only drops
                    // exact duplicates, leaves intentional variants alone.
                    if (s.Timers.Messages.Count > 1)
                    {
                        var seen = new System.Collections.Generic.HashSet<string>();
                        var deduped = new System.Collections.Generic.List<TimedMessage>();
                        foreach (var m in s.Timers.Messages)
                            if (seen.Add((m.Name ?? "") + "||" + (m.Message ?? ""))) deduped.Add(m);
                        s.Timers.Messages = deduped;
                    }
                    if (s.Counters.Counters.Count > 1)
                    {
                        var seen = new System.Collections.Generic.HashSet<string>();
                        var deduped = new System.Collections.Generic.List<Counter>();
                        foreach (var c in s.Counters.Counters)
                            if (seen.Add(c.Name ?? "")) deduped.Add(c);
                        s.Counters.Counters = deduped;
                    }
                    if (s.Goals.Goals.Count > 1)
                    {
                        var seen = new System.Collections.Generic.HashSet<string>();
                        var deduped = new System.Collections.Generic.List<Goal>();
                        foreach (var g in s.Goals.Goals)
                            if (seen.Add((g.Name ?? "") + "||" + (g.Kind ?? ""))) deduped.Add(g);
                        s.Goals.Goals = deduped;
                    }

                    // Each AlertTemplate should be non-null too. An "Alerts": {}
                    // in the JSON nukes them all to null otherwise.
                    var a = s.Alerts;
                    if (a.Follow      == null) a.Follow      = new AlertTemplate { Enabled = true, Message = "{user} just followed!" };
                    if (a.Sub         == null) a.Sub         = new AlertTemplate { Enabled = true, Message = "{user} subscribed!" };
                    if (a.Resub       == null) a.Resub       = new AlertTemplate { Enabled = true, Message = "{user} resubbed for {months} months!" };
                    if (a.GiftSub     == null) a.GiftSub     = new AlertTemplate { Enabled = true, Message = "{gifter} gifted {count} subs!" };
                    if (a.Cheer       == null) a.Cheer       = new AlertTemplate { Enabled = true, Message = "{user} cheered {bits} bits!" };
                    if (a.Raid        == null) a.Raid        = new AlertTemplate { Enabled = true, Message = "Raid from {user} with {viewers} viewers!" };
                    if (a.SuperChat   == null) a.SuperChat   = new AlertTemplate { Enabled = true, Message = "{user} sent a Super Chat: {amount}!" };
                    if (a.Membership  == null) a.Membership  = new AlertTemplate { Enabled = true, Message = "{user} just became a member!" };
                    if (a.KickSub     == null) a.KickSub     = new AlertTemplate { Enabled = true, Message = "{user} subscribed on Kick!" };
                    if (a.KickGift    == null) a.KickGift    = new AlertTemplate { Enabled = true, Message = "{gifter} gifted {count} subs on Kick!" };
                    if (a.TikTokGift  == null) a.TikTokGift  = new AlertTemplate { Enabled = true, Message = "{user} sent {gift} ({coins} coins)!" };
                });
            }
            catch (Exception ex) { Util.ErrorLog.Write("SettingsWindow.EnsureSettingsShape", ex); }
        }

        // -------------------- Header pills --------------------

        private void RefreshHeaderPills()
        {
            var s = SettingsManager.Instance.Current;
            TxtPillTier.Text    = Entitlements.CurrentTierDisplay();
            TxtPillChannel.Text = (s.Updates.Channel ?? "stable").ToLower();
            // Bus secret presence is a decent liveness check.
            try
            {
                var path = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "Aquilo", "bus-secret.txt");
                TxtPillBus.Text = File.Exists(path) ? "Bus :7470" : "Bus offline";
            }
            catch { TxtPillBus.Text = "Bus :7470"; }
        }

        // -------------------- Counters / supporters / check-in --------------------

        private void BindCountersAndCheckIn()
        {
            var s = SettingsManager.Instance.Current;

            _counters.Clear();
            foreach (var c in s.Counters.Counters) _counters.Add(c);
            GrdCounters.ItemsSource = _counters;

            // Counters overlay behavior
            if (TxtCountersOpacity   != null) TxtCountersOpacity.Text   = s.Counters.Opacity.ToString();
            if (TxtCountersHideAfter != null) TxtCountersHideAfter.Text = s.Counters.HideAfterSeconds.ToString();
            if (ChkCountersOnTrigger != null) ChkCountersOnTrigger.IsChecked = s.Counters.ShowOnTriggerOnly;

            _supporters.Clear();
            foreach (var p in s.PatreonSupporters.Supporters) _supporters.Add(p);
            GrdSupporters.ItemsSource = _supporters;

            TxtCheckInReward.Text   = s.CheckIn.TwitchRewardName ?? "";
            TxtCheckInCommand.Text  = s.CheckIn.CrossPlatformCommand ?? "";
            TxtCheckInCooldown.Text = s.CheckIn.CooldownPerUserHours.ToString();
            TxtCheckInRotateSec.Text = s.CheckIn.RotateIntervalSec.ToString();
            TxtCheckInStats.Text    = string.Join(",", s.CheckIn.RotatingStats ?? new List<string>());

            ChkSubFlair.IsChecked     = s.CheckIn.ShowSubFlair;
            ChkVipModFlair.IsChecked  = s.CheckIn.ShowVipModFlair;
            ChkPatreonFlair.IsChecked = s.CheckIn.ShowPatreonFlair;

            switch ((s.CheckIn.AnimationTheme ?? "shimmer").ToLowerInvariant())
            {
                case "bounce":  CmbCheckInTheme.SelectedIndex = 1; break;
                case "glow":    CmbCheckInTheme.SelectedIndex = 2; break;
                case "minimal": CmbCheckInTheme.SelectedIndex = 3; break;
                default:        CmbCheckInTheme.SelectedIndex = 0; break;
            }
        }

        private void BtnCounterAdd_Click(object sender, RoutedEventArgs e)
        {
            _counters.Add(new Counter { Name = "newcounter", Display = "New counter", Value = 0 });
            GrdCounters.SelectedItem = _counters[_counters.Count - 1];
        }
        private void BtnCounterRemove_Click(object sender, RoutedEventArgs e)
        {
            if (GrdCounters.SelectedItem is Counter c && ConfirmRemove("counter")) _counters.Remove(c);
        }
        private void BtnCounterPlus_Click(object sender, RoutedEventArgs e)
        {
            if (GrdCounters.SelectedItem is Counter c) { c.Value++; GrdCounters.Items.Refresh(); PublishCounter(c); }
        }
        private void BtnCounterMinus_Click(object sender, RoutedEventArgs e)
        {
            if (GrdCounters.SelectedItem is Counter c) { c.Value--; GrdCounters.Items.Refresh(); PublishCounter(c); }
        }
        private void BtnCounterReset_Click(object sender, RoutedEventArgs e)
        {
            if (GrdCounters.SelectedItem is Counter c) { c.Value = 0; GrdCounters.Items.Refresh(); PublishCounter(c); }
        }
        private static void PublishCounter(Counter c)
        {
            AquiloBus.Instance.Publish("counter.updated", new
            {
                name    = c.Name,
                display = c.Display,
                value   = c.Value,
                by      = "settings-ui"
            });
        }

        private void BtnSupporterAdd_Click(object sender, RoutedEventArgs e)
        {
            _supporters.Add(new PatreonSupporter { Platform = "twitch", Handle = "username", Tier = "tier2" });
            GrdSupporters.SelectedItem = _supporters[_supporters.Count - 1];
        }
        private void BtnSupporterRemove_Click(object sender, RoutedEventArgs e)
        {
            if (GrdSupporters.SelectedItem is PatreonSupporter p && ConfirmRemove("Patreon supporter")) _supporters.Remove(p);
        }

        // -------------------- Test check-in --------------------

        private void BtnCheckInTest_Click(object sender, RoutedEventArgs e)
        {
            var s = SettingsManager.Instance.Current;
            AquiloBus.Instance.Publish("checkin.shown", new
            {
                user           = s.BroadcasterName ?? "test_user",
                userId         = "test",
                platform       = "twitch",
                role           = "sub",
                subTier        = "1000",
                patreonTier    = (string)null,
                pfp            = (string)null,
                animationTheme = s.CheckIn.AnimationTheme,
                showFlairs     = new { sub = s.CheckIn.ShowSubFlair, vipMod = s.CheckIn.ShowVipModFlair, patreon = s.CheckIn.ShowPatreonFlair },
                stats          = new object[]
                {
                    new { kind = "uptime",  label = "Uptime",  value = "1:23:45" },
                    new { kind = "viewers", label = "Viewers", value = "127" },
                    new { kind = "counter", label = "Deaths",  value = "12" }
                },
                rotateSeconds  = s.CheckIn.RotateIntervalSec,
                source         = "test",
                ts             = DateTime.UtcNow
            });
            ShowSavedHint("Test event published.");
        }

        // -------------------- Patreon --------------------

        private void OnPatreonStateChanged(object sender, PatreonState e)
        {
            Dispatcher.BeginInvoke(new Action(RefreshPatreonState));
        }

        private void RefreshPatreonState()
        {
            var s = PatreonClient.Instance.Current;
            TxtPatreonTier.Text = "Tier: " + Entitlements.CurrentTierDisplay();
            TxtPatreonName.Text = s.SignedIn && !string.IsNullOrEmpty(s.UserName)
                ? "Connected as " + s.UserName + (string.IsNullOrEmpty(s.Email) ? "" : " (" + s.Email + ")")
                : "Not connected.";
            TxtPatreonReason.Text = s.SignedIn && !string.IsNullOrEmpty(s.Reason) && s.Reason != "ok"
                ? "Status: " + s.Reason
                : "";

            BtnPatreonConnect.Visibility = s.SignedIn ? Visibility.Collapsed : Visibility.Visible;
            BtnPatreonRefresh.Visibility = s.SignedIn ? Visibility.Visible : Visibility.Collapsed;
            BtnPatreonSignOut.Visibility = s.SignedIn ? Visibility.Visible : Visibility.Collapsed;

            LstFeatures.Items.Clear();
            foreach (Feature f in Enum.GetValues(typeof(Feature)))
            {
                var unlocked = Entitlements.IsUnlocked(f);
                var prefix = unlocked ? "  ✓  " : "  🔒  ";
                var line = new TextBlock
                {
                    Text = prefix + f,
                    Margin = new Thickness(0, 2, 0, 2),
                    Foreground = unlocked
                        ? (Brush)FindResource("Brush.Fg.Primary")
                        : (Brush)FindResource("Brush.Fg.Muted")
                };
                if (!unlocked) line.ToolTip = Entitlements.GetLockReason(f);
                LstFeatures.Items.Add(line);
            }

            // Header pill should also reflect any tier change.
            TxtPillTier.Text = Entitlements.CurrentTierDisplay();
        }

        private async void BtnPatreonConnect_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                BtnPatreonConnect.IsEnabled = false;
                TxtPatreonReason.Text = "Opening browser… complete sign-in there.";
                await PatreonClient.Instance.StartSignInAsync();
            }
            catch (Exception ex)
            {
                TxtPatreonReason.Text = "Sign-in failed: " + ex.Message;
            }
            finally
            {
                BtnPatreonConnect.IsEnabled = true;
                RefreshPatreonState();
            }
        }
        private async void BtnPatreonRefresh_Click(object sender, RoutedEventArgs e)
        {
            BtnPatreonRefresh.IsEnabled = false;
            try { await PatreonClient.Instance.RefreshEntitlementAsync(); }
            finally { BtnPatreonRefresh.IsEnabled = true; RefreshPatreonState(); }
        }
        private void BtnPatreonSignOut_Click(object sender, RoutedEventArgs e)
        {
            PatreonClient.Instance.SignOut();
            RefreshPatreonState();
        }

        // -------------------- Alerts --------------------

        /// <summary>
        /// Row VM for the Alerts ItemsControl. Edits flow back to the underlying
        /// AlertTemplate via the Apply method called from Save.
        /// </summary>
        public sealed class AlertRow : System.ComponentModel.INotifyPropertyChanged
        {
            public string Label   { get; set; }
            public string Kind    { get; set; }
            private bool   _enabled;
            private string _message;
            public bool   Enabled { get { return _enabled; } set { _enabled = value; OnPC("Enabled"); } }
            public string Message { get { return _message; } set { _message = value; OnPC("Message"); } }
            public AlertTemplate Backing { get; set; }
            public event System.ComponentModel.PropertyChangedEventHandler PropertyChanged;
            private void OnPC(string n) { var h = PropertyChanged; if (h != null) h(this, new System.ComponentModel.PropertyChangedEventArgs(n)); }
            public void Apply()
            {
                if (Backing == null) return;
                Backing.Enabled = Enabled;
                Backing.Message = Message;
            }
        }

        private void BindAlertsTab()
        {
            _alertRows.Clear();
            var a = SettingsManager.Instance.Current.Alerts;
            Action<string, string, AlertTemplate> add = (label, kind, t) =>
                _alertRows.Add(new AlertRow { Label = label, Kind = kind, Backing = t, Enabled = t.Enabled, Message = t.Message });
            add("Follow",          "follow",      a.Follow);
            add("Sub",             "sub",         a.Sub);
            add("Resub",           "resub",       a.Resub);
            add("Gift sub",        "giftSub",     a.GiftSub);
            add("Cheer (bits)",    "cheer",       a.Cheer);
            add("Raid",            "raid",        a.Raid);
            add("Super chat",      "superChat",   a.SuperChat);
            add("YouTube member",  "membership",  a.Membership);
            add("Kick sub",        "kickSub",     a.KickSub);
            add("Kick gift",       "kickGift",    a.KickGift);
            add("TikTok gift",     "tiktokGift",  a.TikTokGift);
            LstAlerts.ItemsSource = _alertRows;
        }

        // -------------------- Timers --------------------

        private void BindTimersTab()
        {
            var s = SettingsManager.Instance.Current;
            _timers.Clear();
            foreach (var t in s.Timers.Messages) _timers.Add(t);
            GrdTimers.ItemsSource = _timers;

            TxtTimersInterval.Text = s.Timers.IntervalMinutes.ToString();
            TxtTimersMinChat.Text  = s.Timers.MinChatMessages.ToString();
            TxtTimersMinWin.Text   = s.Timers.MinChatWindowMinutes.ToString();
            TxtTimersBcPause.Text  = s.Timers.BroadcasterPauseSec.ToString();
        }
        private void BtnTimerAdd_Click(object sender, RoutedEventArgs e)
        {
            _timers.Add(new TimedMessage
            {
                Name = "New timer",
                Message = "Hey chat, did you know...",
                Enabled = true,
                Group = "Default"
            });
            GrdTimers.SelectedItem = _timers[_timers.Count - 1];
        }
        private void BtnTimerRemove_Click(object sender, RoutedEventArgs e)
        {
            if (GrdTimers.SelectedItem is TimedMessage t && ConfirmRemove("timer")) _timers.Remove(t);
        }

        // -------------------- Goals --------------------

        private void BindGoalsTab()
        {
            _goals.Clear();
            foreach (var g in SettingsManager.Instance.Current.Goals.Goals) _goals.Add(g);
            GrdGoals.ItemsSource = _goals;
        }
        private void BtnGoalAdd_Click(object sender, RoutedEventArgs e)
        {
            _goals.Add(new Goal { Name = "New goal", Kind = "subs", Target = 100, Current = 0, Enabled = false });
            GrdGoals.SelectedItem = _goals[_goals.Count - 1];
        }
        private void BtnGoalRemove_Click(object sender, RoutedEventArgs e)
        {
            if (GrdGoals.SelectedItem is Goal g && ConfirmRemove("goal")) _goals.Remove(g);
        }

        // -------------------- Webhooks --------------------

        private void BindWebhooksTab()
        {
            _webhooks.Clear();
            foreach (var w in SettingsManager.Instance.Current.Webhooks.Mappings) _webhooks.Add(w);
            GrdWebhooks.ItemsSource = _webhooks;
        }
        private void BtnWebhookAdd_Click(object sender, RoutedEventArgs e)
        {
            _webhooks.Add(new WebhookMapping { Path = "/new", SbActionId = "", Description = "" });
            GrdWebhooks.SelectedItem = _webhooks[_webhooks.Count - 1];
        }
        private void BtnWebhookRemove_Click(object sender, RoutedEventArgs e)
        {
            if (GrdWebhooks.SelectedItem is WebhookMapping w && ConfirmRemove("webhook mapping")) _webhooks.Remove(w);
        }

        // -------------------- Custom commands --------------------

        private void BindCustomCommandsTab()
        {
            _customCmds.Clear();
            foreach (var c in SettingsManager.Instance.Current.InfoCommands.Custom) _customCmds.Add(c);
            GrdCustomCommands.ItemsSource = _customCmds;
        }
        private void BtnCustomCmdAdd_Click(object sender, RoutedEventArgs e)
        {
            _customCmds.Add(new CustomCommand { Name = "newcmd", Response = "Hello {user}!" });
            GrdCustomCommands.SelectedItem = _customCmds[_customCmds.Count - 1];
        }
        private void BtnCustomCmdRemove_Click(object sender, RoutedEventArgs e)
        {
            if (GrdCustomCommands.SelectedItem is CustomCommand c && ConfirmRemove("custom command")) _customCmds.Remove(c);
        }

        // -------------------- Load all settings into UI --------------------

        private void LoadFromSettings()
        {
            var s = SettingsManager.Instance.Current;
            TxtBroadcaster.Text  = s.BroadcasterName ?? "";

            // Platforms
            ChkTwitch.IsChecked  = s.Platforms.Twitch;
            ChkTikTok.IsChecked  = s.Platforms.TikTok;
            ChkYouTube.IsChecked = s.Platforms.YouTube;
            ChkKick.IsChecked    = s.Platforms.Kick;
            TxtTikTokSendAction.Text = s.Platforms.TikTokSendActionName ?? "";

            CmbChannel.SelectedIndex = string.Equals(s.Updates.Channel, "beta", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
            ChkAutoCheckUpdates.IsChecked = s.Updates.AutoCheck;

            // Modules
            ModInfo.IsChecked        = s.Modules.InfoCommands;
            ModWelcomes.IsChecked    = s.Modules.ContextWelcomes;
            ModFun.IsChecked         = s.Modules.Fun;
            ModFirstWords.IsChecked  = s.Modules.FirstWords;
            ModAutoPoll.IsChecked    = s.Modules.AutoPoll;
            ModAlerts.IsChecked      = s.Modules.Alerts;
            ModTimers.IsChecked      = s.Modules.TimedMessages;
            ModGoals.IsChecked       = s.Modules.Goals;
            ModCounters.IsChecked    = s.Modules.Counters;
            ModSubAnniv.IsChecked    = s.Modules.SubAnniversary;
            ModSubRaidTrain.IsChecked = s.Modules.SubRaidTrain;
            ModBolts.IsChecked       = s.Modules.Bolts;
            ModLoyalty.IsChecked     = s.Modules.LoyaltyWallet;
            ModApex.IsChecked        = s.Modules.Apex;
            ModCheckIn.IsChecked     = s.Modules.DailyCheckIn;
            ModHype.IsChecked        = s.Modules.TikTokHypeTrain;
            ModHateRaid.IsChecked    = s.Modules.HateRaidDetector;
            ModAdBreak.IsChecked     = s.Modules.AdBreak;
            ModChatVel.IsChecked     = s.Modules.ChatVelocity;
            ModVip.IsChecked         = s.Modules.VipRotation;
            ModMod.IsChecked         = s.Modules.Moderation;
            ModCcCoin.IsChecked      = s.Modules.CcCoinTracker;
            ModClips.IsChecked       = s.Modules.Clips;
            ModRecap.IsChecked       = s.Modules.StreamRecap;
            ModGameTracker.IsChecked = s.Modules.GameTracker;
            ModDiscord.IsChecked     = s.Modules.DiscordLiveStatus;
            ModTwitter.IsChecked     = s.Modules.TwitterLiveStatus;
            ModWebhook.IsChecked     = s.Modules.WebhookInbox;

            // Welcomes
            ChkWelcomesEnabled.IsChecked = s.Welcomes.Enabled;
            TxtWelcomeFirstTime.Text = s.Welcomes.FirstTime ?? "";
            TxtWelcomeReturning.Text = s.Welcomes.Returning ?? "";
            TxtWelcomeRegular.Text   = s.Welcomes.Regular   ?? "";
            TxtWelcomeSub.Text       = s.Welcomes.Sub       ?? "";
            TxtWelcomeVip.Text       = s.Welcomes.Vip       ?? "";
            TxtWelcomeMod.Text       = s.Welcomes.Mod       ?? "";

            // Info commands
            TxtInfoDiscord.Text = s.InfoCommands.Discord ?? "";
            TxtInfoSocials.Text = s.InfoCommands.Socials ?? "";

            // Quiet / chat noise
            ChkQuietMode.IsChecked     = s.ChatNoise.QuietMode;
            TxtMaxChatPerMin.Text      = s.ChatNoise.MaxChatPerMinute.ToString();
            ChkAreaAlerts.IsChecked    = s.ChatNoise.AlertsToChat;
            ChkAreaWelcomes.IsChecked  = s.ChatNoise.WelcomesToChat;
            ChkAreaInfo.IsChecked      = s.ChatNoise.InfoCommandsToChat;
            ChkAreaCounters.IsChecked  = s.ChatNoise.CountersToChat;
            ChkAreaBolts.IsChecked     = s.ChatNoise.BoltsToChat;
            ChkAreaGoals.IsChecked     = s.ChatNoise.GoalsToChat;
            TxtInfoCooldown.Text       = s.ChatNoise.InfoCommandCooldownSec.ToString();
            TxtCounterAckCooldown.Text = s.ChatNoise.CounterAckCooldownSec.ToString();
            TxtCounterAckEveryN.Text   = s.ChatNoise.CounterAckEveryN.ToString();

            // Bolts
            TxtBoltsName.Text         = s.Bolts.DisplayName ?? "";
            TxtBoltsEmoji.Text        = s.Bolts.Emoji ?? "";
            TxtBoltsPerChat.Text      = s.Bolts.PerChatMessage.ToString();
            TxtBoltsPerSub.Text       = s.Bolts.PerSub.ToString();
            TxtBoltsPerGiftSub.Text   = s.Bolts.PerGiftSub.ToString();
            TxtBoltsPerRaid.Text      = s.Bolts.PerRaidBrought.ToString();
            TxtBoltsBitsDivisor.Text  = s.Bolts.PerCheerBitDivisor.ToString();
            TxtBoltsCcDivisor.Text    = s.Bolts.PerCcCoinDivisor.ToString();
            TxtBoltsCheckIn.Text      = s.Bolts.PerDailyCheckIn.ToString();
            TxtBoltsAnnivBase.Text    = s.Bolts.SubAnniversaryBonusBase.ToString();
            TxtBoltsMulSub.Text       = s.Bolts.SubMultiplier.ToString();
            TxtBoltsMulT1.Text        = s.Bolts.PatreonTier1Bonus.ToString();
            TxtBoltsMulT2.Text        = s.Bolts.PatreonTier2Bonus.ToString();
            TxtBoltsMulT3.Text        = s.Bolts.PatreonTier3Bonus.ToString();
            TxtBoltsStreakPer.Text    = s.Bolts.DailyStreakPerDay.ToString();
            TxtBoltsStreakCap.Text    = s.Bolts.DailyStreakCap.ToString();
            TxtBoltsAfkCap.Text       = s.Bolts.MaxChatEarnsPerMinute.ToString();
            TxtBoltsGiftFloor.Text    = s.Bolts.GiftMinAmount.ToString();
            TxtBoltsRainMin.Text      = s.Bolts.BoltRainMinTotal.ToString();
            TxtBoltsRainMax.Text      = s.Bolts.BoltRainMaxRecipients.ToString();
            if (TxtBoltsSlotsPool != null) TxtBoltsSlotsPool.Text = s.Bolts.SlotsImagePool ?? "";
            // Minigames bounds + per-user cooldown + result delay.
            if (TxtBoltsGameCd       != null) TxtBoltsGameCd.Text       = s.Bolts.GamePerUserCooldownSec.ToString();
            if (TxtBoltsGameDelay    != null) TxtBoltsGameDelay.Text    = s.Bolts.GameResultDelayMs.ToString();
            if (TxtBoltsCoinflipMin  != null) TxtBoltsCoinflipMin.Text  = s.Bolts.CoinflipMinWager.ToString();
            if (TxtBoltsCoinflipMax  != null) TxtBoltsCoinflipMax.Text  = s.Bolts.CoinflipMaxWager.ToString();
            if (TxtBoltsDiceMin      != null) TxtBoltsDiceMin.Text      = s.Bolts.DiceMinWager.ToString();
            if (TxtBoltsDiceMax      != null) TxtBoltsDiceMax.Text      = s.Bolts.DiceMaxWager.ToString();
            if (TxtBoltsDiceMult     != null) TxtBoltsDiceMult.Text     = s.Bolts.DicePayoutMultiplier.ToString();

            ChkRotationEnabled.IsChecked = s.RotationIntegration.Enabled;
            TxtRotationCmd.Text          = s.RotationIntegration.Command ?? "";
            TxtRotationCost.Text         = s.RotationIntegration.Cost.ToString();
            TxtRotationCd.Text           = s.RotationIntegration.PerUserCooldownSec.ToString();
            TxtRotationRefund.Text       = s.RotationIntegration.RefundOnFailureSec.ToString();

            // Apex
            TxtApexStartHP.Text     = s.Apex.StartingHealth.ToString();
            TxtApexChatThr.Text     = s.Apex.ChatAnnounceDamageThreshold.ToString();
            TxtApexDmgSub.Text      = s.Apex.DamageSub.ToString();
            TxtApexDmgResub.Text    = s.Apex.DamageResub.ToString();
            TxtApexDmgGift.Text     = s.Apex.DamageGiftSub.ToString();
            TxtApexDmgBits.Text     = s.Apex.DamagePerHundredBits.ToString();
            TxtApexDmgTikTok.Text   = s.Apex.DamagePerTikTokCoin.ToString();
            TxtApexDmgCcCoin.Text   = s.Apex.DamagePerCcCoin.ToString();
            TxtApexDmgBolts.Text    = s.Apex.DamagePerBoltsSpent.ToString();
            TxtApexDmgChanPt.Text   = s.Apex.DamagePerChannelPointRedemption.ToString();
            TxtApexDmgCheckIn.Text  = s.Apex.DamagePerCheckIn.ToString();
            TxtApexDmgRaid.Text     = s.Apex.DamagePerRaidViewer.ToString();
            ChkApexAutoCrown.IsChecked  = s.Apex.AutoCrownFinisher;
            ChkApexSelfImm.IsChecked    = s.Apex.SelfImmunity;
            ChkApexIncBcaster.IsChecked = s.Apex.IncludeBroadcaster;
            ChkApexAnnounce.IsChecked   = s.Apex.AnnounceCrownChange;
            TxtApexDiscord.Text         = s.Apex.DiscordWebhook ?? "";

            // Hate raid / moderation
            TxtHateAccountAge.Text   = s.Moderation.HateRaidAccountAgeHrs.ToString();
            TxtHateWindow.Text       = s.Moderation.HateRaidWindowSec.ToString();
            TxtHateMinAccounts.Text  = s.Moderation.HateRaidMinAccounts.ToString();
            ChkHateRaidDet.IsChecked = s.Moderation.HateRaidDetector;
            ChkLinkPerms.IsChecked   = s.Moderation.LinkPermsByRole;
            ChkCopypasta.IsChecked   = s.Moderation.CopypastaDetect;

            // VIP rotation
            TxtVipInterval.Text  = s.VipRotation.IntervalDays.ToString();
            TxtVipPerCycle.Text  = s.VipRotation.RotationsPerCycle.ToString();
            TxtVipMinMsg.Text    = s.VipRotation.MinMessages.ToString();
            TxtVipExempt.Text    = string.Join(Environment.NewLine, s.VipRotation.ExemptHandles ?? new List<string>());
            TxtVipDiscord.Text   = s.VipRotation.DiscordWebhook ?? "";

            // Clips
            ChkClipsEnabled.IsChecked = s.Clips.Enabled;
            TxtClipCommand.Text       = s.Clips.Command ?? "";
            TxtClipRoles.Text         = s.Clips.AllowedRoles ?? "";
            TxtClipUserCd.Text        = s.Clips.PerUserCooldownSec.ToString();
            TxtClipModCd.Text         = s.Clips.ModCooldownSec.ToString();
            TxtClipChannelCd.Text     = s.Clips.ChannelCooldownSec.ToString();
            TxtClipBoltsAward.Text    = s.Clips.AwardBolts.ToString();
            ChkClipBotAcct.IsChecked  = s.Clips.UseBotAccount;
            ChkClipDelay.IsChecked    = s.Clips.HasDelay;
            ChkClipAck.IsChecked      = s.Clips.AckInChat;
            TxtClipAck.Text           = s.Clips.AckTemplate ?? "";
            TxtClipPost.Text          = s.Clips.PostTemplate ?? "";
            TxtClipDiscordWebhook.Text  = s.Clips.DiscordWebhook ?? "";
            TxtClipDiscordTemplate.Text = s.Clips.DiscordTemplate ?? "";

            // Discord
            TxtDiscordWebhook.Text  = s.Discord.LiveStatusWebhook ?? "";
            TxtDiscordRecap.Text    = s.Discord.RecapWebhook ?? "";
            TxtDiscordTemplate.Text = s.Discord.GoLiveTemplate ?? "";
            ChkDiscordAutoEdit.IsChecked = s.Discord.AutoEditOnChange;
            ChkDiscordArchive.IsChecked  = s.Discord.ArchiveOnOffline;

            // Twitter / X
            TxtTwitterWebhook.Text         = s.Twitter.LiveWebhook ?? "";
            TxtTwitterLiveTemplate.Text    = s.Twitter.LiveTemplate ?? "";
            TxtTwitterOfflineTemplate.Text = s.Twitter.OfflineTemplate ?? "";
            ChkTwitterPostOnUpdate.IsChecked = s.Twitter.PostOnUpdate;

            // Webhooks
            ChkWebhookEnabled.IsChecked = s.Webhooks.Enabled;
            TxtWebhookPort.Text         = s.Webhooks.Port.ToString();
            TxtWebhookSecret.Text       = s.Webhooks.SharedSecret ?? "";

            // Follow batch (Welcomes tab)
            ChkFollowBatchEnabled.IsChecked = s.FollowBatch.Enabled;
            TxtFollowBatchWindow.Text       = s.FollowBatch.WindowSeconds.ToString();
            TxtFollowBatchMin.Text          = s.FollowBatch.MinToTrigger.ToString();
            TxtFollowBatchMaxNames.Text     = s.FollowBatch.MaxNamesShown.ToString();
            TxtFollowBatchTemplate.Text     = s.FollowBatch.Template ?? "";

            // Discord embed
            var em = s.Discord.Embed ?? new DiscordEmbedConfig();
            ChkEmbedUse.IsChecked     = em.Use;
            TxtEmbedTitle.Text        = em.Title ?? "";
            TxtEmbedDescription.Text  = em.Description ?? "";
            TxtEmbedColor.Text        = em.ColorHex ?? "#3A86FF";
            TxtEmbedImage.Text        = em.ImageUrl ?? "";
            TxtEmbedThumb.Text        = em.ThumbUrl ?? "";
            TxtEmbedAuthor.Text       = em.AuthorName ?? "";
            TxtEmbedAuthorIcon.Text   = em.AuthorIcon ?? "";
            TxtEmbedFooter.Text       = em.FooterText ?? "";
            TxtEmbedFooterIcon.Text   = em.FooterIcon ?? "";
        }

        // -------------------- Save --------------------

        private void BtnSave_Click(object sender, RoutedEventArgs e)
        {
            // Push every alert row's edits back to the AlertTemplate it wraps.
            foreach (var row in _alertRows) row.Apply();

            SettingsManager.Instance.Mutate(s =>
            {
                s.BroadcasterName = (TxtBroadcaster.Text ?? "").Trim();

                // Platforms
                s.Platforms.Twitch  = ChkTwitch.IsChecked  == true;
                s.Platforms.TikTok  = ChkTikTok.IsChecked  == true;
                s.Platforms.YouTube = ChkYouTube.IsChecked == true;
                s.Platforms.Kick    = ChkKick.IsChecked    == true;
                s.Platforms.TikTokSendActionName = (TxtTikTokSendAction.Text ?? "").Trim();

                s.Updates.Channel   = ((ComboBoxItem)CmbChannel.SelectedItem)?.Tag?.ToString() ?? "stable";
                s.Updates.AutoCheck = ChkAutoCheckUpdates.IsChecked == true;

                // Modules
                s.Modules.InfoCommands       = ModInfo.IsChecked == true;
                s.Modules.ContextWelcomes    = ModWelcomes.IsChecked == true;
                s.Modules.Fun                = ModFun.IsChecked == true;
                s.Modules.FirstWords         = ModFirstWords.IsChecked == true;
                s.Modules.AutoPoll           = ModAutoPoll.IsChecked == true;
                s.Modules.Alerts             = ModAlerts.IsChecked == true;
                s.Modules.TimedMessages      = ModTimers.IsChecked == true;
                s.Modules.Goals              = ModGoals.IsChecked == true;
                s.Modules.Counters           = ModCounters.IsChecked == true;
                s.Modules.SubAnniversary     = ModSubAnniv.IsChecked == true;
                s.Modules.SubRaidTrain       = ModSubRaidTrain.IsChecked == true;
                s.Modules.Bolts              = ModBolts.IsChecked == true;
                s.Modules.LoyaltyWallet      = ModLoyalty.IsChecked == true;
                s.Modules.Apex               = ModApex.IsChecked == true;
                s.Modules.DailyCheckIn       = ModCheckIn.IsChecked == true;
                s.Modules.TikTokHypeTrain    = ModHype.IsChecked == true;
                s.Modules.HateRaidDetector   = ModHateRaid.IsChecked == true;
                s.Modules.AdBreak            = ModAdBreak.IsChecked == true;
                s.Modules.ChatVelocity       = ModChatVel.IsChecked == true;
                s.Modules.VipRotation        = ModVip.IsChecked == true;
                s.Modules.Moderation         = ModMod.IsChecked == true;
                s.Modules.CcCoinTracker      = ModCcCoin.IsChecked == true;
                s.Modules.Clips              = ModClips.IsChecked == true;
                s.Modules.StreamRecap        = ModRecap.IsChecked == true;
                s.Modules.GameTracker        = ModGameTracker.IsChecked == true;
                s.Modules.DiscordLiveStatus  = ModDiscord.IsChecked == true;
                s.Modules.TwitterLiveStatus  = ModTwitter.IsChecked == true;
                s.Modules.WebhookInbox       = ModWebhook.IsChecked == true;

                // Welcomes
                s.Welcomes.Enabled   = ChkWelcomesEnabled.IsChecked == true;
                s.Welcomes.FirstTime = TxtWelcomeFirstTime.Text ?? "";
                s.Welcomes.Returning = TxtWelcomeReturning.Text ?? "";
                s.Welcomes.Regular   = TxtWelcomeRegular.Text   ?? "";
                s.Welcomes.Sub       = TxtWelcomeSub.Text       ?? "";
                s.Welcomes.Vip       = TxtWelcomeVip.Text       ?? "";
                s.Welcomes.Mod       = TxtWelcomeMod.Text       ?? "";

                // Info commands
                s.InfoCommands.Discord = TxtInfoDiscord.Text ?? "";
                s.InfoCommands.Socials = TxtInfoSocials.Text ?? "";
                s.InfoCommands.Custom  = _customCmds.ToList();

                // Quiet / chat noise
                s.ChatNoise.QuietMode             = ChkQuietMode.IsChecked == true;
                int iv;
                if (int.TryParse(TxtMaxChatPerMin.Text, out iv) && iv >= 1)
                    s.ChatNoise.MaxChatPerMinute = iv;
                s.ChatNoise.AlertsToChat          = ChkAreaAlerts.IsChecked    == true;
                s.ChatNoise.WelcomesToChat        = ChkAreaWelcomes.IsChecked  == true;
                s.ChatNoise.InfoCommandsToChat    = ChkAreaInfo.IsChecked      == true;
                s.ChatNoise.CountersToChat        = ChkAreaCounters.IsChecked  == true;
                s.ChatNoise.BoltsToChat           = ChkAreaBolts.IsChecked     == true;
                s.ChatNoise.GoalsToChat           = ChkAreaGoals.IsChecked     == true;
                if (int.TryParse(TxtInfoCooldown.Text, out iv)       && iv >= 0) s.ChatNoise.InfoCommandCooldownSec = iv;
                if (int.TryParse(TxtCounterAckCooldown.Text, out iv) && iv >= 0) s.ChatNoise.CounterAckCooldownSec  = iv;
                if (int.TryParse(TxtCounterAckEveryN.Text, out iv)   && iv >= 0) s.ChatNoise.CounterAckEveryN        = iv;

                // Counters / supporters
                s.Counters.Counters = _counters.ToList();
                if (int.TryParse(TxtCountersOpacity?.Text,   out iv) && iv >= 0 && iv <= 100) s.Counters.Opacity = iv;
                if (int.TryParse(TxtCountersHideAfter?.Text, out iv) && iv >= 1)              s.Counters.HideAfterSeconds = iv;
                s.Counters.ShowOnTriggerOnly = ChkCountersOnTrigger?.IsChecked == true;
                s.PatreonSupporters.Supporters = _supporters.ToList();

                // Timers
                s.Timers.Messages = _timers.ToList();
                if (int.TryParse(TxtTimersInterval.Text, out iv) && iv >= 1) s.Timers.IntervalMinutes      = iv;
                if (int.TryParse(TxtTimersMinChat.Text,  out iv) && iv >= 0) s.Timers.MinChatMessages      = iv;
                if (int.TryParse(TxtTimersMinWin.Text,   out iv) && iv >= 1) s.Timers.MinChatWindowMinutes = iv;
                if (int.TryParse(TxtTimersBcPause.Text,  out iv) && iv >= 0) s.Timers.BroadcasterPauseSec  = iv;

                // Goals
                s.Goals.Goals = _goals.ToList();

                // Bolts
                s.Bolts.DisplayName     = (TxtBoltsName.Text  ?? "Bolts").Trim();
                s.Bolts.Emoji           = (TxtBoltsEmoji.Text ?? "⚡").Trim();
                if (int.TryParse(TxtBoltsPerChat.Text,    out iv) && iv >= 0) s.Bolts.PerChatMessage     = iv;
                if (int.TryParse(TxtBoltsPerSub.Text,     out iv) && iv >= 0) s.Bolts.PerSub             = iv;
                if (int.TryParse(TxtBoltsPerGiftSub.Text, out iv) && iv >= 0) s.Bolts.PerGiftSub         = iv;
                if (int.TryParse(TxtBoltsPerRaid.Text,    out iv) && iv >= 0) s.Bolts.PerRaidBrought     = iv;
                if (int.TryParse(TxtBoltsBitsDivisor.Text,out iv) && iv >= 1) s.Bolts.PerCheerBitDivisor = iv;
                if (int.TryParse(TxtBoltsCcDivisor.Text,  out iv) && iv >= 1) s.Bolts.PerCcCoinDivisor   = iv;
                if (int.TryParse(TxtBoltsCheckIn.Text,    out iv) && iv >= 0) s.Bolts.PerDailyCheckIn    = iv;
                if (int.TryParse(TxtBoltsAnnivBase.Text,  out iv) && iv >= 0) s.Bolts.SubAnniversaryBonusBase = iv;
                double dv;
                if (double.TryParse(TxtBoltsMulSub.Text,    out dv) && dv >= 0) s.Bolts.SubMultiplier     = dv;
                if (double.TryParse(TxtBoltsMulT1.Text,     out dv) && dv >= 0) s.Bolts.PatreonTier1Bonus = dv;
                if (double.TryParse(TxtBoltsMulT2.Text,     out dv) && dv >= 0) s.Bolts.PatreonTier2Bonus = dv;
                if (double.TryParse(TxtBoltsMulT3.Text,     out dv) && dv >= 0) s.Bolts.PatreonTier3Bonus = dv;
                if (double.TryParse(TxtBoltsStreakPer.Text, out dv) && dv >= 0) s.Bolts.DailyStreakPerDay = dv;
                if (double.TryParse(TxtBoltsStreakCap.Text, out dv) && dv >= 0) s.Bolts.DailyStreakCap    = dv;
                if (int.TryParse(TxtBoltsAfkCap.Text,    out iv) && iv >= 0) s.Bolts.MaxChatEarnsPerMinute = iv;
                if (int.TryParse(TxtBoltsGiftFloor.Text, out iv) && iv >= 0) s.Bolts.GiftMinAmount         = iv;
                if (int.TryParse(TxtBoltsRainMin.Text,   out iv) && iv >= 0) s.Bolts.BoltRainMinTotal      = iv;
                if (int.TryParse(TxtBoltsRainMax.Text,   out iv) && iv >= 1) s.Bolts.BoltRainMaxRecipients = iv;
                // Slots reel pool: collapse Windows CRLF -> LF so what the
                // overlay reads matches what the user typed in the textbox.
                if (TxtBoltsSlotsPool != null) s.Bolts.SlotsImagePool = (TxtBoltsSlotsPool.Text ?? "").Replace("\r\n", "\n").Trim();
                // Minigames knobs. Wide range guards (0..3600 cd, 0..30000
                // delay, 0..million wager) so the streamer can lower bounds
                // to zero to disable a game without a separate toggle.
                if (int.TryParse(TxtBoltsGameCd?.Text,      out iv) && iv >= 0 && iv <= 3600)   s.Bolts.GamePerUserCooldownSec = iv;
                if (int.TryParse(TxtBoltsGameDelay?.Text,   out iv) && iv >= 0 && iv <= 30000)  s.Bolts.GameResultDelayMs      = iv;
                if (int.TryParse(TxtBoltsCoinflipMin?.Text, out iv) && iv >= 0)                 s.Bolts.CoinflipMinWager       = iv;
                if (int.TryParse(TxtBoltsCoinflipMax?.Text, out iv) && iv >= 0)                 s.Bolts.CoinflipMaxWager       = iv;
                if (int.TryParse(TxtBoltsDiceMin?.Text,     out iv) && iv >= 0)                 s.Bolts.DiceMinWager           = iv;
                if (int.TryParse(TxtBoltsDiceMax?.Text,     out iv) && iv >= 0)                 s.Bolts.DiceMaxWager           = iv;
                if (int.TryParse(TxtBoltsDiceMult?.Text,    out iv) && iv >= 2 && iv <= 100)    s.Bolts.DicePayoutMultiplier   = iv;

                // Global overlay theme (font / scale / accent2 / text).
                if (s.OverlayTheme == null) s.OverlayTheme = new OverlayThemeConfig();
                var themeFont = (CmbOverlayFont?.SelectedItem as ComboBoxItem)?.Tag?.ToString();
                s.OverlayTheme.Font = string.IsNullOrWhiteSpace(themeFont) ? "" : themeFont;
                if (double.TryParse((TxtOverlayFontScale?.Text ?? "1").Trim(), System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var scaleVal)
                    && scaleVal > 0 && scaleVal <= 3) s.OverlayTheme.FontScale = scaleVal;
                s.OverlayTheme.Accent2 = NormalizeHex(TxtOverlayAccent2?.Text) ?? "";
                s.OverlayTheme.Text    = NormalizeHex(TxtOverlayText?.Text)    ?? "";

                // Custom commands-ticker icons. Empty textboxes drop
                // the entry so the overlay falls back to its default.
                if (s.CommandsTickerIcons == null) s.CommandsTickerIcons = new CommandsTickerIconsConfig();
                if (s.CommandsTickerIcons.ByCategory == null) s.CommandsTickerIcons.ByCategory = new Dictionary<string, string>();
                var iconDict = s.CommandsTickerIcons.ByCategory;
                iconDict.Clear();
                void StoreIcon(string cat, string val)
                {
                    var t = (val ?? "").Trim();
                    if (!string.IsNullOrEmpty(t)) iconDict[cat] = t;
                }
                StoreIcon("info",    TxtIconInfo?.Text);
                StoreIcon("custom",  TxtIconCustom?.Text);
                StoreIcon("bolts",   TxtIconBolts?.Text);
                StoreIcon("clip",    TxtIconClip?.Text);
                StoreIcon("checkin", TxtIconCheckin?.Text);
                StoreIcon("counter", TxtIconCounter?.Text);
                StoreIcon("mod",     TxtIconMod?.Text);
                StoreIcon("song",    TxtIconSong?.Text);

                // Rotation connection (typed config — drives !song chat
                // command behaviour through NowPlayingModule).
                if (s.RotationConnection == null) s.RotationConnection = new RotationConnectionConfig();
                s.RotationConnection.BaseUrl  = (TxtRotationBaseUrl?.Text ?? "").Trim();
                s.RotationConnection.Variant  = SelectedTag(CmbRotationVariant);
                if (string.IsNullOrEmpty(s.RotationConnection.Variant)) s.RotationConnection.Variant = "widget";
                s.RotationConnection.SongCommandEnabled = ChkRotationSongCmd?.IsChecked == true;
                var rotCmd = (TxtRotationSongCmd?.Text ?? "!song").Trim();
                if (rotCmd.Length > 0 && rotCmd[0] != '!') rotCmd = "!" + rotCmd;
                if (rotCmd.Length < 2) rotCmd = "!song";
                s.RotationConnection.SongCommand = rotCmd;
                if (int.TryParse((TxtRotationSongCooldown?.Text ?? "30").Trim(), out var rotCd) && rotCd >= 0)
                    s.RotationConnection.SongCooldownSec = rotCd;

                // Capture every per-overlay control's current value so the
                // streamer's per-card customizations (positions, accents,
                // bgOpacity, layer toggles, command-include filters, etc.)
                // survive a Settings restart and aren't transient anymore.
                if (s.OverlayTheme.CardValues == null)
                    s.OverlayTheme.CardValues = new Dictionary<string, string>();
                else
                    s.OverlayTheme.CardValues.Clear();
                CaptureOverlayCardValues(s.OverlayTheme.CardValues);

                // Rotation integration
                s.RotationIntegration.Enabled = ChkRotationEnabled.IsChecked == true;
                s.RotationIntegration.Command = (TxtRotationCmd.Text ?? "!boltsong").Trim();
                if (int.TryParse(TxtRotationCost.Text, out iv)   && iv >= 0) s.RotationIntegration.Cost                = iv;
                if (int.TryParse(TxtRotationCd.Text, out iv)     && iv >= 0) s.RotationIntegration.PerUserCooldownSec  = iv;
                if (int.TryParse(TxtRotationRefund.Text, out iv) && iv >= 0) s.RotationIntegration.RefundOnFailureSec  = iv;

                // Apex
                if (int.TryParse(TxtApexStartHP.Text,    out iv) && iv >= 1) s.Apex.StartingHealth                  = iv;
                if (int.TryParse(TxtApexChatThr.Text,    out iv) && iv >= 0) s.Apex.ChatAnnounceDamageThreshold     = iv;
                if (int.TryParse(TxtApexDmgSub.Text,     out iv) && iv >= 0) s.Apex.DamageSub                       = iv;
                if (int.TryParse(TxtApexDmgResub.Text,   out iv) && iv >= 0) s.Apex.DamageResub                     = iv;
                if (int.TryParse(TxtApexDmgGift.Text,    out iv) && iv >= 0) s.Apex.DamageGiftSub                   = iv;
                if (int.TryParse(TxtApexDmgBits.Text,    out iv) && iv >= 0) s.Apex.DamagePerHundredBits            = iv;
                if (int.TryParse(TxtApexDmgTikTok.Text,  out iv) && iv >= 0) s.Apex.DamagePerTikTokCoin             = iv;
                if (int.TryParse(TxtApexDmgCcCoin.Text,  out iv) && iv >= 0) s.Apex.DamagePerCcCoin                 = iv;
                if (int.TryParse(TxtApexDmgBolts.Text,   out iv) && iv >= 0) s.Apex.DamagePerBoltsSpent             = iv;
                if (int.TryParse(TxtApexDmgChanPt.Text,  out iv) && iv >= 0) s.Apex.DamagePerChannelPointRedemption = iv;
                if (int.TryParse(TxtApexDmgCheckIn.Text, out iv) && iv >= 0) s.Apex.DamagePerCheckIn                = iv;
                if (int.TryParse(TxtApexDmgRaid.Text,    out iv) && iv >= 0) s.Apex.DamagePerRaidViewer             = iv;
                s.Apex.AutoCrownFinisher    = ChkApexAutoCrown.IsChecked  == true;
                s.Apex.SelfImmunity         = ChkApexSelfImm.IsChecked    == true;
                s.Apex.IncludeBroadcaster   = ChkApexIncBcaster.IsChecked == true;
                s.Apex.AnnounceCrownChange  = ChkApexAnnounce.IsChecked   == true;
                s.Apex.DiscordWebhook       = (TxtApexDiscord.Text ?? "").Trim();

                // Hate raid / moderation
                if (int.TryParse(TxtHateAccountAge.Text,  out iv) && iv >= 0) s.Moderation.HateRaidAccountAgeHrs = iv;
                if (int.TryParse(TxtHateWindow.Text,      out iv) && iv >= 1) s.Moderation.HateRaidWindowSec     = iv;
                if (int.TryParse(TxtHateMinAccounts.Text, out iv) && iv >= 1) s.Moderation.HateRaidMinAccounts   = iv;
                s.Moderation.HateRaidDetector = ChkHateRaidDet.IsChecked == true;
                s.Moderation.LinkPermsByRole  = ChkLinkPerms.IsChecked   == true;
                s.Moderation.CopypastaDetect  = ChkCopypasta.IsChecked   == true;

                // VIP rotation
                if (int.TryParse(TxtVipInterval.Text, out iv) && iv >= 1) s.VipRotation.IntervalDays      = iv;
                if (int.TryParse(TxtVipPerCycle.Text, out iv) && iv >= 1) s.VipRotation.RotationsPerCycle = iv;
                if (int.TryParse(TxtVipMinMsg.Text,   out iv) && iv >= 0) s.VipRotation.MinMessages       = iv;
                s.VipRotation.ExemptHandles = (TxtVipExempt.Text ?? "")
                    .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(x => x.Trim()).Where(x => !string.IsNullOrEmpty(x)).ToList();
                s.VipRotation.DiscordWebhook = (TxtVipDiscord.Text ?? "").Trim();

                // Clips
                s.Clips.Enabled            = ChkClipsEnabled.IsChecked == true;
                s.Clips.Command            = (TxtClipCommand.Text ?? "!clip").Trim();
                s.Clips.AllowedRoles       = (TxtClipRoles.Text ?? "").Trim();
                if (int.TryParse(TxtClipUserCd.Text,    out iv) && iv >= 0) s.Clips.PerUserCooldownSec = iv;
                if (int.TryParse(TxtClipModCd.Text,     out iv) && iv >= 0) s.Clips.ModCooldownSec     = iv;
                if (int.TryParse(TxtClipChannelCd.Text, out iv) && iv >= 0) s.Clips.ChannelCooldownSec = iv;
                if (int.TryParse(TxtClipBoltsAward.Text,out iv) && iv >= 0) s.Clips.AwardBolts         = iv;
                s.Clips.UseBotAccount      = ChkClipBotAcct.IsChecked == true;
                s.Clips.HasDelay           = ChkClipDelay.IsChecked   == true;
                s.Clips.AckInChat          = ChkClipAck.IsChecked     == true;
                s.Clips.AckTemplate        = TxtClipAck.Text  ?? "";
                s.Clips.PostTemplate       = TxtClipPost.Text ?? "";
                s.Clips.DiscordWebhook     = (TxtClipDiscordWebhook.Text  ?? "").Trim();
                s.Clips.DiscordTemplate    = TxtClipDiscordTemplate.Text  ?? "";

                // Discord
                s.Discord.LiveStatusWebhook = (TxtDiscordWebhook.Text ?? "").Trim();
                s.Discord.RecapWebhook      = (TxtDiscordRecap.Text   ?? "").Trim();
                s.Discord.GoLiveTemplate    = TxtDiscordTemplate.Text ?? s.Discord.GoLiveTemplate;
                s.Discord.AutoEditOnChange  = ChkDiscordAutoEdit.IsChecked == true;
                s.Discord.ArchiveOnOffline  = ChkDiscordArchive.IsChecked  == true;

                // Twitter / X
                s.Twitter.LiveWebhook     = (TxtTwitterWebhook.Text ?? "").Trim();
                s.Twitter.LiveTemplate    = TxtTwitterLiveTemplate.Text    ?? "";
                s.Twitter.OfflineTemplate = TxtTwitterOfflineTemplate.Text ?? "";
                s.Twitter.PostOnUpdate    = ChkTwitterPostOnUpdate.IsChecked == true;

                // Webhooks
                s.Webhooks.Enabled = ChkWebhookEnabled.IsChecked == true;
                if (int.TryParse(TxtWebhookPort.Text, out var port) && port > 0 && port < 65536)
                    s.Webhooks.Port = port;
                s.Webhooks.SharedSecret = (TxtWebhookSecret.Text ?? "").Trim();
                s.Webhooks.Mappings = _webhooks.ToList();

                // Follow batch
                s.FollowBatch.Enabled  = ChkFollowBatchEnabled.IsChecked == true;
                if (int.TryParse(TxtFollowBatchWindow.Text,   out iv) && iv >= 5)  s.FollowBatch.WindowSeconds = iv;
                if (int.TryParse(TxtFollowBatchMin.Text,      out iv) && iv >= 2)  s.FollowBatch.MinToTrigger  = iv;
                if (int.TryParse(TxtFollowBatchMaxNames.Text, out iv) && iv >= 1)  s.FollowBatch.MaxNamesShown = iv;
                s.FollowBatch.Template = TxtFollowBatchTemplate.Text ?? s.FollowBatch.Template;

                // Discord embed
                if (s.Discord.Embed == null) s.Discord.Embed = new DiscordEmbedConfig();
                s.Discord.Embed.Use         = ChkEmbedUse.IsChecked == true;
                s.Discord.Embed.Title       = TxtEmbedTitle.Text       ?? "";
                s.Discord.Embed.Description = TxtEmbedDescription.Text ?? "";
                s.Discord.Embed.ColorHex    = (TxtEmbedColor.Text      ?? "#3A86FF").Trim();
                s.Discord.Embed.ImageUrl    = (TxtEmbedImage.Text      ?? "").Trim();
                s.Discord.Embed.ThumbUrl    = (TxtEmbedThumb.Text      ?? "").Trim();
                s.Discord.Embed.AuthorName  = TxtEmbedAuthor.Text       ?? "";
                s.Discord.Embed.AuthorIcon  = (TxtEmbedAuthorIcon.Text ?? "").Trim();
                s.Discord.Embed.FooterText  = TxtEmbedFooter.Text      ?? "";
                s.Discord.Embed.FooterIcon  = (TxtEmbedFooterIcon.Text ?? "").Trim();

                // Game profiles + channel points
                s.GameProfiles.Enabled = ChkGameProfilesEnabled.IsChecked == true;
                s.GameProfiles.Profiles = _gameProfiles.ToList();
                s.ChannelPoints.Enabled = ChkChannelPointsEnabled.IsChecked == true;
                s.ChannelPoints.Mappings = _channelPoints.ToList();

                // Discord bot. Most fields are managed by the claim-flow
                // handlers; Save just captures the few free-form ones.
                s.DiscordBot.Enabled   = ChkDiscordBotEnabled.IsChecked == true;
                s.DiscordBot.WorkerUrl = (TxtDcbWorkerUrl.Text ?? "").Trim();
                s.DiscordBot.SyncMode  = ((ComboBoxItem)CmbDcbSyncMode.SelectedItem)?.Tag?.ToString() ?? "merge";
                if (int.TryParse(TxtDcbAutoSync.Text, out iv) && iv >= 0) s.DiscordBot.AutoSyncMinutes = iv;

                // Bolts shop
                s.BoltsShop.Enabled     = ChkShopEnabled.IsChecked == true;
                s.BoltsShop.ShopCommand = (TxtShopCmd.Text ?? "!shop").Trim();
                s.BoltsShop.BuyCommand  = (TxtBuyCmd.Text  ?? "!buy").Trim();
                s.BoltsShop.Items       = _shopItems.ToList();

                // Tuning tab — pushes every numeric / template config for
                // the previously-hardcoded modules (HypeTrain / AdBreak /
                // ChatVelocity / AutoPoll / SubAnniversary / SubRaidTrain
                // / CcCoin / FirstWords).
                SaveTuningTab(s);

                // Check-In fields.
                s.CheckIn.TwitchRewardName     = (TxtCheckInReward.Text   ?? "").Trim();
                s.CheckIn.CrossPlatformCommand = (TxtCheckInCommand.Text  ?? "").Trim();
                int cdh; if (int.TryParse(TxtCheckInCooldown.Text, out cdh) && cdh >= 0)
                    s.CheckIn.CooldownPerUserHours = cdh;
                int rsec; if (int.TryParse(TxtCheckInRotateSec.Text, out rsec) && rsec > 0)
                    s.CheckIn.RotateIntervalSec = rsec;
                s.CheckIn.AnimationTheme = ((ComboBoxItem)CmbCheckInTheme.SelectedItem)?.Tag?.ToString() ?? "shimmer";
                s.CheckIn.ShowSubFlair     = ChkSubFlair.IsChecked     == true;
                s.CheckIn.ShowVipModFlair  = ChkVipModFlair.IsChecked  == true;
                s.CheckIn.ShowPatreonFlair = ChkPatreonFlair.IsChecked == true;
                s.CheckIn.RotatingStats = (TxtCheckInStats.Text ?? "")
                    .Split(',')
                    .Select(x => x.Trim())
                    .Where(x => !string.IsNullOrEmpty(x))
                    .ToList();
            });
            SettingsManager.Instance.SaveNow();
            ShowSavedHint("Saved at " + DateTime.Now.ToString("HH:mm:ss"));
            RefreshHeaderPills();
        }

        // -------------------- Footer status pill --------------------

        private System.Windows.Threading.DispatcherTimer _savedHintTimer;

        private void ShowSavedHint(string text)
        {
            TxtSavedHint.Text = text;
            PillSaved.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;

            // Auto-hide after 3 seconds so the toast doesn't linger forever.
            if (_savedHintTimer == null)
            {
                _savedHintTimer = new System.Windows.Threading.DispatcherTimer
                    { Interval = TimeSpan.FromSeconds(3) };
                _savedHintTimer.Tick += (s, e) =>
                {
                    _savedHintTimer.Stop();
                    PillSaved.Visibility = Visibility.Collapsed;
                };
            }
            _savedHintTimer.Stop();
            if (!string.IsNullOrEmpty(text)) _savedHintTimer.Start();
        }

        // Confirm dialog before destructive removes. Each Remove handler
        // gates the actual collection mutation on the return value so a
        // misclick on the Remove button doesn't lose user data.
        private bool ConfirmRemove(string what)
        {
            var r = System.Windows.MessageBox.Show(
                "Remove this " + what + "?\n\nThe change applies on Save.",
                "Confirm remove",
                System.Windows.MessageBoxButton.OKCancel,
                System.Windows.MessageBoxImage.Question,
                System.Windows.MessageBoxResult.Cancel);
            return r == System.Windows.MessageBoxResult.OK;
        }

        // Opens the streamer's Twitch dashboard for managing channel-point
        // rewards. SB's CPH API can read rewards (TwitchGetRewards) but
        // not create / edit / delete them — that's done on Twitch.tv.
        private void BtnOpenTwitchRewards_Click(object sender, RoutedEventArgs e)
        {
            var name = SettingsManager.Instance.Current.BroadcasterName;
            var url = string.IsNullOrWhiteSpace(name)
                ? "https://dashboard.twitch.tv/u/_/viewer-rewards/channel-points/rewards"
                : "https://dashboard.twitch.tv/u/" + System.Net.WebUtility.UrlEncode(name) +
                  "/viewer-rewards/channel-points/rewards";
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });
                ShowSavedHint("Opened Twitch dashboard.");
            }
            catch (Exception ex) { ShowSavedHint("Open failed: " + ex.Message); }
        }

        // Step-by-step popup for connecting TikFinity's bot to Loadout's
        // TikTok send path. Reachable via the "TikFinity setup guide"
        // button next to the TikTok send action field.
        private void BtnTikFinityGuide_Click(object sender, RoutedEventArgs e)
        {
            System.Windows.MessageBox.Show(
                "TikFinity bot setup — let Loadout post to TikTok\n\n" +
                "1. Open TikFinity. Settings → Bot Mode → enable. Sign your TikTok\n" +
                "   account into TikFinity's bot. (TikFinity walks you through the\n" +
                "   account auth.)\n\n" +
                "2. Once Bot Mode is on, TikFinity registers a Streamer.bot Action\n" +
                "   you can call. Look in SB's Actions list for it (commonly named\n" +
                "   something like \"TikFinity: Send Bot Message\" — exact name\n" +
                "   varies by TikFinity version).\n\n" +
                "3. Open that action in SB. Add a sub-action:\n" +
                "     • Get Global Variable → loadoutTikTokMessage → into a local var\n" +
                "     • Set Argument 'message' (or whatever TikFinity's send sub-action\n" +
                "       reads) to that local var\n" +
                "     • TikFinity's bot send sub-action runs with the message\n\n" +
                "4. Note the action's exact name in SB.\n\n" +
                "5. Back in Loadout (this Settings window) → General → \"TikTok send\n" +
                "   action\". Paste the action name. Click Save.\n\n" +
                "6. Test it: tick TikTok on a timer in Settings → Timers (the platform\n" +
                "   tickbox column), hit Save, and wait for the sequence interval. Or\n" +
                "   fire any alert that targets TikTok.\n\n" +
                "Tips\n" +
                "  • Dry-run mode (Health → Diagnostics) logs would-have-sent messages\n" +
                "    instead of posting — verify wiring without spamming chat.\n" +
                "  • Loadout caps outbound TikTok at 6 messages/min so a flood of timer\n" +
                "    fires can't trip TikFinity's rate-limit.\n" +
                "  • Command responses (e.g. !uptime asked from TikTok chat) route back\n" +
                "    through this same path automatically.",
                "Loadout — TikFinity setup",
                System.Windows.MessageBoxButton.OK,
                System.Windows.MessageBoxImage.Information);
        }

        // Quick reference popup for template variables. Wired to the
        // "Variables" button in the header so it's reachable from any tab
        // without scrolling around looking for the right Variables: hint.
        private void BtnVariables_Click(object sender, RoutedEventArgs e)
        {
            System.Windows.MessageBox.Show(
                "Common variables you can use in templates:\n\n" +
                "Streamer-context:\n" +
                "  {broadcaster}        your channel name\n" +
                "  {title} {game} {url} current stream\n\n" +
                "User-context:\n" +
                "  {user} {handle}      viewer username\n" +
                "  {tier}               sub tier (1, 2, 3)\n" +
                "  {months}             sub anniversary count\n" +
                "  {viewers}            raid viewer count\n" +
                "  {gifter} {count}     gift-sub source + total\n" +
                "  {bits} {amount}      cheer / super-chat amount\n" +
                "  {gift} {coins}       TikTok gift name + coins\n\n" +
                "Counters / wallets:\n" +
                "  {display} {value}    counter name + value\n" +
                "  {balance} {streak}   bolts wallet\n\n" +
                "Variables that aren't relevant to a given event resolve\n" +
                "to empty. Use them anywhere a TextBox accepts a template.",
                "Loadout - template variables",
                System.Windows.MessageBoxButton.OK,
                System.Windows.MessageBoxImage.Information);
        }

        // Module health dashboard: a row per module with the icon, name,
        // and an On/Off pill. Total count + summary lands at the top. The
        // landing tab on window open so the streamer sees what's wired up
        // before drilling into individual settings.
        private void BindHealthTab()
        {
            if (HealthList == null) return;
            HealthList.Children.Clear();

            var s = SettingsManager.Instance.Current;
            var modules = new System.Collections.Generic.List<(string Name, bool Enabled, string IconKey)>
            {
                ("Info commands",       s.Modules.InfoCommands,       "IconGeo.Commands"),
                ("Welcomes",            s.Modules.ContextWelcomes,    "IconGeo.Welcomes"),
                ("Alerts",              s.Modules.Alerts,             "IconGeo.Alerts"),
                ("Auto-messages",       s.Modules.TimedMessages,      "IconGeo.Timers"),
                ("Goals",               s.Modules.Goals,              "IconGeo.Goals"),
                ("Counters",            s.Modules.Counters,           "IconGeo.Counters"),
                ("Bolts wallet",        s.Modules.Bolts,              "IconGeo.Bolts"),
                ("Apex (top viewer)",   s.Modules.Apex,               "IconGeo.Apex"),
                ("Daily check-in",      s.Modules.DailyCheckIn,       "IconGeo.CheckIn"),
                ("Stream recap",        s.Modules.StreamRecap,        "IconGeo.Recap"),
                ("Discord live status", s.Modules.DiscordLiveStatus,  "IconGeo.Discord"),
                ("Hate-raid detector",  s.Modules.HateRaidDetector,   "IconGeo.HateRaid"),
                ("Hype train",          s.Modules.TikTokHypeTrain,    "IconGeo.HypeTrain"),
                ("Sub raid train",      s.Modules.SubRaidTrain,       "IconGeo.SubRaidTrain"),
                ("Sub anniversary",     s.Modules.SubAnniversary,     "IconGeo.SubAnniv"),
                ("Ad break heads-up",   s.Modules.AdBreak,            "IconGeo.AdBreak"),
                ("First words",         s.Modules.FirstWords,         "IconGeo.Welcomes"),
                ("Auto-poll",           s.Modules.AutoPoll,           "IconGeo.AutoPoll"),
                ("VIP rotation",        s.Modules.VipRotation,        "IconGeo.Vip"),
                ("CC coins",            s.Modules.CcCoinTracker,      "IconGeo.CcCoin"),
                ("Webhook inbox",       s.Modules.WebhookInbox,       "IconGeo.Webhooks"),
                ("Clips",               s.Modules.Clips,              "IconGeo.Clips"),
                ("Channel points",      s.ChannelPoints?.Enabled ?? false, "IconGeo.ChannelPoints"),
                ("Game profiles",       s.GameProfiles?.Enabled ?? false,  "IconGeo.GameProfiles"),
            };

            int onCount = 0;
            var pillStyleOn   = (Style)FindResource("PillSuccess");
            var pillStyle     = (Style)FindResource("Pill");
            var iconStyle     = (Style)FindResource("Icon");
            var iconStyleDim  = (Style)FindResource("IconMuted");
            var mutedBrush    = (System.Windows.Media.Brush)FindResource("Brush.Fg.Muted");

            foreach (var m in modules)
            {
                if (m.Enabled) onCount++;

                var row = new Grid { Margin = new Thickness(0, 5, 0, 5) };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

                var iconPath = new System.Windows.Shapes.Path
                {
                    Style = m.Enabled ? iconStyle : iconStyleDim,
                    Data = (Geometry)FindResource(m.IconKey),
                    Width = 14, Height = 14,
                    Margin = new Thickness(0, 0, 12, 0)
                };
                Grid.SetColumn(iconPath, 0);
                row.Children.Add(iconPath);

                var name = new TextBlock
                {
                    Text = m.Name,
                    VerticalAlignment = VerticalAlignment.Center,
                    Foreground = m.Enabled ? (System.Windows.Media.Brush)FindResource("Brush.Fg.Primary") : mutedBrush
                };
                Grid.SetColumn(name, 1);
                row.Children.Add(name);

                var pill = new Border
                {
                    Style = m.Enabled ? pillStyleOn : pillStyle,
                    VerticalAlignment = VerticalAlignment.Center
                };
                var pillStack = new StackPanel { Orientation = Orientation.Horizontal };
                if (m.Enabled)
                    pillStack.Children.Add(new System.Windows.Shapes.Ellipse
                    {
                        Width = 6, Height = 6,
                        Fill = (System.Windows.Media.Brush)FindResource("Brush.Success"),
                        VerticalAlignment = VerticalAlignment.Center,
                        Margin = new Thickness(0, 0, 6, 0)
                    });
                pillStack.Children.Add(new TextBlock
                {
                    Text = m.Enabled ? "On" : "Off",
                    FontSize = 11,
                    Foreground = mutedBrush,
                    VerticalAlignment = VerticalAlignment.Center
                });
                pill.Child = pillStack;
                Grid.SetColumn(pill, 2);
                row.Children.Add(pill);

                HealthList.Children.Add(row);
            }

            TxtHealthSummary.Text = onCount + " of " + modules.Count + " modules enabled. " +
                "Click a module's tab on the left to configure or toggle it.";

            // Dry-run toggle reflects whatever the current settings hold.
            if (ChkDryRun != null) ChkDryRun.IsChecked = s.DryRun;

            // Activity (this session): per-event-kind counters. Top 20 by count.
            if (ActivityList != null)
            {
                ActivityList.Children.Clear();
                var stats = Util.EventStats.Instance.Snapshot();
                if (TxtActivitySince != null)
                    TxtActivitySince.Text = "since " + Util.EventStats.Instance.SinceUtc.ToLocalTime().ToString("HH:mm");

                if (stats.Count == 0)
                {
                    ActivityList.Children.Add(new TextBlock
                    {
                        Text = "No events yet — fire a Test button (Alerts / Welcomes / Check-In) or wait for chat traffic.",
                        Foreground = mutedBrush,
                        TextWrapping = TextWrapping.Wrap
                    });
                }
                else
                {
                    var ordered = new System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, int>>(stats);
                    ordered.Sort((a, b) => b.Value.CompareTo(a.Value));
                    var take = Math.Min(ordered.Count, 20);
                    // Per-(kind → module → count) drill-down. Modules call
                    // EventStats.Hit() at the moment they actually act
                    // (send chat, fire alert, publish to bus) so the chip
                    // counts represent work done, not "saw the dispatch".
                    var actions = Util.EventStats.Instance.SnapshotActions();
                    var primaryBrush = (System.Windows.Media.Brush)FindResource("Brush.Fg.Primary");
                    for (int i = 0; i < take; i++)
                    {
                        var kv = ordered[i];
                        var row = new StackPanel { Margin = new Thickness(0, 4, 0, 4) };

                        var head = new Grid();
                        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                        var label = new TextBlock { Text = kv.Key, Foreground = mutedBrush };
                        Grid.SetColumn(label, 0);
                        head.Children.Add(label);
                        var count = new TextBlock
                        {
                            Text = kv.Value.ToString(),
                            FontWeight = FontWeights.SemiBold,
                            Foreground = primaryBrush
                        };
                        Grid.SetColumn(count, 1);
                        head.Children.Add(count);
                        row.Children.Add(head);

                        // Inline module chips beneath the kind row, e.g.
                        // "Welcomes 4 · Alerts 2". Trims module suffix
                        // ("WelcomesModule" -> "Welcomes") for readability.
                        if (actions.TryGetValue(kv.Key, out var byModule) && byModule.Count > 0)
                        {
                            var modOrdered = new System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, int>>(byModule);
                            modOrdered.Sort((a, b) => b.Value.CompareTo(a.Value));
                            var chips = new System.Text.StringBuilder();
                            for (int j = 0; j < modOrdered.Count; j++)
                            {
                                if (j > 0) chips.Append("  ·  ");
                                var name = modOrdered[j].Key;
                                if (name.EndsWith("Module", StringComparison.Ordinal))
                                    name = name.Substring(0, name.Length - "Module".Length);
                                chips.Append(name).Append(' ').Append(modOrdered[j].Value);
                            }
                            row.Children.Add(new TextBlock
                            {
                                Text = chips.ToString(),
                                Foreground = mutedBrush,
                                FontSize = 11,
                                Margin = new Thickness(0, 1, 0, 0)
                            });
                        }

                        ActivityList.Children.Add(row);
                    }
                }
            }
        }

        // Reset-to-defaults: wipe every settings section back to its
        // constructor default while preserving broadcaster identity +
        // platform mask + onboarding status. Persists immediately so a
        // confirmation reload renders the empty state.
        private void BtnResetAllDefaults_Click(object sender, RoutedEventArgs e)
        {
            var r = System.Windows.MessageBox.Show(
                "Reset every settings section back to defaults?\n\n" +
                "Wipes: alerts, timers, goals, counters, welcomes, webhooks, custom commands, " +
                "Bolts wallet config, Apex config, Discord templates, etc.\n\n" +
                "Keeps: your broadcaster name, the platforms you stream on, and onboarding status.\n\n" +
                "This change applies on Save.",
                "Reset all settings",
                System.Windows.MessageBoxButton.OKCancel,
                System.Windows.MessageBoxImage.Warning,
                System.Windows.MessageBoxResult.Cancel);
            if (r != System.Windows.MessageBoxResult.OK) return;

            var current = SettingsManager.Instance.Current;
            var name      = current.BroadcasterName;
            var platforms = current.Platforms;
            var done      = current.OnboardingDone;
            var dryRun    = current.DryRun;

            // Replace every field we know on the live instance with a fresh
            // default. Done in-place rather than swapping the Current
            // reference because callers across the suite already hold the
            // ref and that would silently desync them.
            var fresh = new LoadoutSettings();
            current.SchemaVersion       = fresh.SchemaVersion;
            current.SuiteVersion        = fresh.SuiteVersion;
            current.OnboardingDone      = done;
            current.BroadcasterName     = name;
            current.DryRun              = dryRun;
            current.Platforms           = platforms;
            current.Modules             = fresh.Modules;
            current.Alerts              = fresh.Alerts;
            current.Timers              = fresh.Timers;
            current.Discord             = fresh.Discord;
            current.Twitter             = fresh.Twitter;
            current.Webhooks            = fresh.Webhooks;
            current.Moderation          = fresh.Moderation;
            current.Welcomes            = fresh.Welcomes;
            current.Updates             = fresh.Updates;
            current.Counters            = fresh.Counters;
            current.CheckIn             = fresh.CheckIn;
            current.PatreonSupporters   = fresh.PatreonSupporters;
            current.InfoCommands        = fresh.InfoCommands;
            current.Goals               = fresh.Goals;
            current.VipRotation         = fresh.VipRotation;
            current.Bolts               = fresh.Bolts;
            current.ChatNoise           = fresh.ChatNoise;
            current.Apex                = fresh.Apex;
            current.RotationIntegration = fresh.RotationIntegration;
            current.Clips               = fresh.Clips;
            current.FollowBatch         = fresh.FollowBatch;
            current.GameProfiles        = fresh.GameProfiles;
            current.ChannelPoints       = fresh.ChannelPoints;
            current.DiscordBot          = fresh.DiscordBot;
            current.BoltsShop           = fresh.BoltsShop;
            current.HypeTrain           = fresh.HypeTrain;
            current.AdBreak             = fresh.AdBreak;
            current.ChatVelocity        = fresh.ChatVelocity;
            current.AutoPoll            = fresh.AutoPoll;
            current.SubAnniversary      = fresh.SubAnniversary;
            current.SubRaidTrain        = fresh.SubRaidTrain;
            current.CcCoin              = fresh.CcCoin;
            current.FirstWords          = fresh.FirstWords;

            // Re-bind every tab so the new default state is visible.
            try { LoadFromSettings(); } catch { }
            try { BindCountersAndCheckIn(); } catch { }
            try { BindGamesTab(); } catch { }
            try { BindOverlaysTab(); } catch { }
            try { BindAlertsTab(); } catch { }
            try { BindTimersTab(); } catch { }
            try { BindGoalsTab(); } catch { }
            try { BindWebhooksTab(); } catch { }
            try { BindCustomCommandsTab(); } catch { }
            try { BindGameProfilesTab(); } catch { }
            try { BindChannelPointsTab(); } catch { }
            try { BindDiscordBotTab(); } catch { }
            try { BindWalletsAndShop(); } catch { }
            try { BindTuningTab(); } catch { }
            try { RefreshHeaderPills(); } catch { }
            try { RefreshStatusChips(); } catch { }
            try { BindHealthTab(); } catch { }

            ShowSavedHint("All settings reset. Click Save to persist.");
        }

        private void BtnHealthRefresh_Click(object sender, RoutedEventArgs e)
        {
            BindHealthTab();
            RefreshStatusChips();
            ShowSavedHint("Health refreshed.");
        }

        // Dry-run toggle: written through to settings immediately so it
        // takes effect this session without needing a Save click. Save
        // still persists the value to disk for next launch.
        private void ChkDryRun_Click(object sender, RoutedEventArgs e)
        {
            var on = ChkDryRun?.IsChecked == true;
            SettingsManager.Instance.Current.DryRun = on;
            ShowSavedHint(on
                ? "Dry-run ON — chat sends are logged, not posted."
                : "Dry-run OFF — chat sends go live again.");
        }

        // Empty-state hints: subscribe to the ObservableCollections that
        // back the data grids and toggle the "no items yet" hint visibility
        // on every change. Beats remembering to call Refresh from each
        // Add/Remove handler.
        private void HookEmptyStates()
        {
            _timers.CollectionChanged   += (s, e) => RefreshEmptyStates();
            _goals.CollectionChanged    += (s, e) => RefreshEmptyStates();
            _counters.CollectionChanged += (s, e) => RefreshEmptyStates();
            RefreshEmptyStates();
        }

        private void RefreshEmptyStates()
        {
            if (TxtTimersEmpty   != null) TxtTimersEmpty.Visibility   = _timers.Count   == 0 ? Visibility.Visible : Visibility.Collapsed;
            if (TxtGoalsEmpty    != null) TxtGoalsEmpty.Visibility    = _goals.Count    == 0 ? Visibility.Visible : Visibility.Collapsed;
            if (TxtCountersEmpty != null) TxtCountersEmpty.Visibility = _counters.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        }

        // Footer connection chips: at-a-glance health for each integration.
        // Twitch / TikTok reflect what's enabled in settings; Bus reads the
        // local secret file; Worker probes /health asynchronously so the
        // window paints fast and the chip lights up when the response lands.
        private void RefreshStatusChips()
        {
            var s = SettingsManager.Instance.Current;
            var ok  = (System.Windows.Media.Brush)FindResource("Brush.Success");
            var dim = (System.Windows.Media.Brush)FindResource("Brush.Border.Strong");

            if (ChipTwitchDot != null) ChipTwitchDot.Fill = s.Platforms.Twitch ? ok : dim;
            if (ChipTikTokDot != null) ChipTikTokDot.Fill = s.Platforms.TikTok ? ok : dim;

            if (ChipBusDot != null)
            {
                var sec = TryReadBusSecret();
                ChipBusDot.Fill = (!string.IsNullOrEmpty(sec) && !sec.Contains("not started")) ? ok : dim;
            }

            if (ChipWorkerDot != null) ChipWorkerDot.Fill = dim;
            _ = ProbeWorkerHealthAsync();
        }

        private async System.Threading.Tasks.Task ProbeWorkerHealthAsync()
        {
            var workerUrl = SettingsManager.Instance.Current.DiscordBot?.WorkerUrl;
            if (string.IsNullOrEmpty(workerUrl)) return;
            try
            {
                using (var http = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(5) })
                {
                    var r = await http.GetAsync(workerUrl.TrimEnd('/') + "/health");
                    await Dispatcher.InvokeAsync(() =>
                    {
                        if (ChipWorkerDot == null) return;
                        ChipWorkerDot.Fill = r.IsSuccessStatusCode
                            ? (System.Windows.Media.Brush)FindResource("Brush.Success")
                            : (System.Windows.Media.Brush)FindResource("Brush.Warn");
                    });
                }
            }
            catch
            {
                await Dispatcher.InvokeAsync(() =>
                {
                    if (ChipWorkerDot == null) return;
                    ChipWorkerDot.Fill = (System.Windows.Media.Brush)FindResource("Brush.Error");
                });
            }
        }

        // -------------------- Versions / closing / re-onboard --------------------

        private void BtnClose_Click(object sender, RoutedEventArgs e) => Close();

        private void BtnReonboard_Click(object sender, RoutedEventArgs e)
        {
            new OnboardingWindow().Show();
            Close();
        }

        private async void BtnCheckUpdate_Click(object sender, RoutedEventArgs e)
        {
            TxtVersionLine.Text = "Checking for updates…";
            var result = await UpdateChecker.Instance.CheckNowAsync();
            RefreshVersionLine();
            if (result == UpdateCheckResult.NewerAvailable)
                ShowSavedHint("Update available - see tray icon or release page.");
            else if (result == UpdateCheckResult.UpToDate)
                ShowSavedHint("You're on the latest version.");
            else
                ShowSavedHint("Update check failed (" + result + ").");
        }

        private void RefreshVersionLine()
        {
            var s = SettingsManager.Instance.Current;
            var lastChecked = s.Updates.LastCheckedUtc == DateTime.MinValue
                ? "never"
                : s.Updates.LastCheckedUtc.ToLocalTime().ToString("g");
            TxtVersionLine.Text = "Version " + s.SuiteVersion + " · channel " + s.Updates.Channel + " · last checked " + lastChecked;
        }

        private void RefreshPendingLinks()
        {
            var pending = IdentityLinker.Instance.PendingRequests();
            TxtPendingLinks.Text = pending.Count == 0
                ? "No pending requests."
                : string.Join("\n", pending.Select(r =>
                    "• " + r.SourcePlatform.ToShortName() + ":" + r.SourceUser + " ↔ " + r.TargetPlatform.ToShortName() + ":" + r.TargetUser + " (id " + r.Id.Substring(0, 8) + ")"));
        }

        // ── Games tab ────────────────────────────────────────────────────────

        private readonly ObservableCollection<GameStat> _games = new ObservableCollection<GameStat>();

        private void BindGamesTab()
        {
            GameStatsStore.Instance.Initialize();
            GrdGames.ItemsSource = _games;
            ReloadGames();
        }

        private void ReloadGames()
        {
            _games.Clear();
            foreach (var g in GameStatsStore.Instance.All()) _games.Add(g);
            var current = GameStatsStore.Instance.CurrentGame;
            TxtCurrentGame.Text = string.IsNullOrEmpty(current)
                ? "  No active session."
                : "  Currently streaming: " + current;
        }

        private void BtnGamesRefresh_Click(object sender, RoutedEventArgs e) => ReloadGames();

        private void BtnGamesReset_Click(object sender, RoutedEventArgs e)
        {
            var confirm = MessageBox.Show(this,
                "Wipe all tracked game stats? Sessions counts, total hours, and peak viewers will reset to zero. Per-game 'reset on switch' choices stay.",
                "Reset game stats", MessageBoxButton.OKCancel, MessageBoxImage.Warning);
            if (confirm != MessageBoxResult.OK) return;
            GameStatsStore.Instance.Reset();
            ReloadGames();
        }

        // ── Overlays tab ─────────────────────────────────────────────────────

        private const string DefaultOverlayBase = "https://widget.aquilo.gg/overlays";

        private void BindOverlaysTab()
        {
            TxtBusSecret.Text = TryReadBusSecret();
            TxtOverlayBaseUrl.Text = DefaultOverlayBase;

            // Load persisted global theme so streamers don't have to re-pick
            // their font / accent2 / text every time SB starts. Per-overlay
            // accent + bgOpacity remain transient (each overlay's URL bakes
            // them in once the streamer drops it into OBS).
            var theme = SettingsManager.Instance.Current.OverlayTheme ?? new OverlayThemeConfig();
            if (CmbOverlayFont != null && !string.IsNullOrEmpty(theme.Font))
            {
                foreach (ComboBoxItem item in CmbOverlayFont.Items)
                {
                    if (string.Equals(item.Tag?.ToString(), theme.Font, StringComparison.Ordinal))
                    { CmbOverlayFont.SelectedItem = item; break; }
                }
            }
            if (TxtOverlayFontScale != null) TxtOverlayFontScale.Text =
                theme.FontScale > 0 ? theme.FontScale.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) : "1.0";
            if (TxtOverlayAccent2 != null) TxtOverlayAccent2.Text = theme.Accent2 ?? "";
            if (TxtOverlayText    != null) TxtOverlayText.Text    = theme.Text    ?? "";

            // Custom commands-ticker icons (per-category badge override).
            // Stored as a flat dict; load each known category into its
            // textbox. Empty values are fine — they signal "use default".
            var icons = SettingsManager.Instance.Current.CommandsTickerIcons?.ByCategory
                        ?? new Dictionary<string, string>();
            string IconVal(string cat) => icons.TryGetValue(cat, out var v) ? v : "";
            if (TxtIconInfo    != null) TxtIconInfo.Text    = IconVal("info");
            if (TxtIconCustom  != null) TxtIconCustom.Text  = IconVal("custom");
            if (TxtIconBolts   != null) TxtIconBolts.Text   = IconVal("bolts");
            if (TxtIconClip    != null) TxtIconClip.Text    = IconVal("clip");
            if (TxtIconCheckin != null) TxtIconCheckin.Text = IconVal("checkin");
            if (TxtIconCounter != null) TxtIconCounter.Text = IconVal("counter");
            if (TxtIconMod     != null) TxtIconMod.Text     = IconVal("mod");
            if (TxtIconSong    != null) TxtIconSong.Text    = IconVal("song");

            // Rotation connection: typed config (drives runtime behaviour
            // through NowPlayingModule), so load via SettingsManager rather
            // than the opaque CardValues bag.
            var rot = SettingsManager.Instance.Current.RotationConnection ?? new RotationConnectionConfig();
            if (TxtRotationBaseUrl     != null) TxtRotationBaseUrl.Text     = rot.BaseUrl ?? "";
            if (TxtRotationSongCmd     != null) TxtRotationSongCmd.Text     = string.IsNullOrEmpty(rot.SongCommand) ? "!song" : rot.SongCommand;
            if (TxtRotationSongCooldown!= null) TxtRotationSongCooldown.Text= (rot.SongCooldownSec > 0 ? rot.SongCooldownSec : 30).ToString();
            if (ChkRotationSongCmd     != null) ChkRotationSongCmd.IsChecked= rot.SongCommandEnabled;
            if (CmbRotationVariant     != null && !string.IsNullOrEmpty(rot.Variant))
            {
                foreach (ComboBoxItem item in CmbRotationVariant.Items)
                {
                    if (string.Equals(item.Tag?.ToString(), rot.Variant, StringComparison.Ordinal))
                    { CmbRotationVariant.SelectedItem = item; break; }
                }
            }

            // Restore every per-overlay textbox / combo / checkbox from
            // the saved CardValues bag. Must happen AFTER TxtOverlayBaseUrl
            // is seeded above so a saved BaseUrl override wins, but BEFORE
            // _overlayTabReady = true so we don't generate a flurry of URL
            // refreshes for each control as it gets set.
            RestoreOverlayCardValues(theme.CardValues);

            // BAML parsing is complete by the time we reach BindOverlaysTab in
            // the constructor (it runs after InitializeComponent's parse + every
            // child element is materialized), so it's safe to flip the gate.
            // From here on, ComboBox / TextBox change handlers can run.
            _overlayTabReady = true;
            RefreshOverlayUrls();
        }

        // Tracks whether the Overlays tab is fully bound. ComboBoxes with
        // IsSelected="True" raise SelectionChanged during BAML parsing -
        // each one fires OnOverlayUrlChange BEFORE the rest of the tree
        // exists. We swallow those calls until BindOverlaysTab signals
        // that every named control is materialized. Without this guard,
        // RefreshOverlayUrls dereferences a null TxtUrlCounters/Bolts/etc.
        // and the whole window construction fails with NRE.
        private bool _overlayTabReady;

        private void OnOverlayUrlChange(object sender, RoutedEventArgs e) => RefreshOverlayUrls();
        private void OnOverlayUrlChange(object sender, TextChangedEventArgs e) => RefreshOverlayUrls();
        private void OnOverlayUrlChange(object sender, SelectionChangedEventArgs e) => RefreshOverlayUrls();

        private void RefreshOverlayUrls()
        {
            // Bail out cleanly if we're being called from XAML parsing's
            // initial selection-changed events (the offending path was a
            // ComboBox raising SelectionChanged before TxtUrlCounters etc.
            // had been instantiated by the parser).
            if (!_overlayTabReady) return;
            if (TxtUrlCheckIn == null) return;

            var baseUrl = (TxtOverlayBaseUrl?.Text ?? DefaultOverlayBase).TrimEnd('/');
            var secret  = TxtBusSecret?.Text ?? "";

            TxtUrlCheckIn.Text = BuildOverlayUrl(baseUrl, "check-in", secret, new Dictionary<string, string>
            {
                ["pos"]       = SelectedTag(CmbCheckInOverlayPos),
                ["accent"]    = NormalizeHex(TxtCheckInAccent?.Text),
                ["bgOpacity"] = string.IsNullOrWhiteSpace(TxtCheckInBgOpacity?.Text) ? null : ClampInt(TxtCheckInBgOpacity.Text, 0, 100, 94)
            });
            // Counters overlay-behavior knobs surface to the URL only when
            // they diverge from defaults (opacity 100 / hideAfter 6 /
            // showOnTrigger off) so the URL stays compact in the common case.
            string countersOpacity     = ClampInt(TxtCountersOpacity?.Text, 0, 100, 100);
            string countersHideAfter   = ClampInt(TxtCountersHideAfter?.Text, 1, 600, 6);
            bool   countersShowTrigger = ChkCountersOnTrigger?.IsChecked == true;
            TxtUrlCounters.Text = BuildOverlayUrl(baseUrl, "counters", secret, new Dictionary<string, string>
            {
                ["theme"]         = SelectedTag(CmbCountersTheme),
                ["layout"]        = SelectedTag(CmbCountersLayout),
                ["accent"]        = NormalizeHex(TxtCountersAccent?.Text),
                ["bgOpacity"]     = string.IsNullOrWhiteSpace(TxtCountersBgOpacity?.Text) ? null : ClampInt(TxtCountersBgOpacity.Text, 0, 100, 94),
                ["opacity"]       = countersOpacity == "100" ? null : countersOpacity,
                ["showOnTrigger"] = countersShowTrigger ? "1" : null,
                ["hideAfter"]     = countersShowTrigger && countersHideAfter != "6" ? countersHideAfter : null
            });
            TxtUrlGoals.Text = BuildOverlayUrl(baseUrl, "goals", secret, new Dictionary<string, string>
            {
                ["theme"]     = SelectedTag(CmbGoalsTheme),
                ["accent"]    = NormalizeHex(TxtGoalsAccent?.Text),
                ["bgOpacity"] = string.IsNullOrWhiteSpace(TxtGoalsBgOpacity?.Text) ? null : ClampInt(TxtGoalsBgOpacity.Text, 0, 100, 94)
            });
            var layers = new List<string>();
            if (ChkLayerLeaderboard?.IsChecked == true) layers.Add("leaderboard");
            if (ChkLayerToast?.IsChecked       == true) layers.Add("toast");
            if (ChkLayerRain?.IsChecked        == true) layers.Add("rain");
            if (ChkLayerStreak?.IsChecked      == true) layers.Add("streak");
            if (ChkLayerGiftBurst?.IsChecked   == true) layers.Add("giftburst");
            if (ChkLayerWelcomes?.IsChecked    == true) layers.Add("welcomes");
            // Bolts theme knobs - hex inputs and small numeric fields. Empty
            // values (or out-of-range) drop the param so the overlay falls back
            // to its baked-in defaults rather than a broken URL.
            string boltsAccent = NormalizeHex(TxtBoltsAccent?.Text);
            string boltsLbRows = ClampInt(TxtBoltsLbRows?.Text, 1, 10, 5);
            string boltsToastDur = ClampInt(TxtBoltsToastDur?.Text, 1, 30, 4);
            string boltsBgOpacity = ClampInt(TxtBoltsBgOpacity?.Text, 0, 100, 94);
            TxtUrlBolts.Text = BuildOverlayUrl(baseUrl, "bolts", secret, new Dictionary<string, string>
            {
                ["layers"]    = layers.Count == 6 ? null : string.Join(",", layers),
                ["accent"]    = boltsAccent,
                ["lbRows"]    = boltsLbRows == "5"  ? null : boltsLbRows,
                ["toastDur"]  = boltsToastDur == "4"  ? null : boltsToastDur,
                ["bgOpacity"] = boltsBgOpacity == "94" ? null : boltsBgOpacity
            });
            TxtUrlApex.Text = BuildOverlayUrl(baseUrl, "apex", secret, new Dictionary<string, string>
            {
                ["pos"]       = SelectedTag(CmbApexPos),
                ["accent"]    = NormalizeHex(TxtApexAccent?.Text),
                ["bgOpacity"] = string.IsNullOrWhiteSpace(TxtApexBgOpacity?.Text) ? null : ClampInt(TxtApexBgOpacity.Text, 0, 100, 94)
            });

            // Commands rotator overlay. The "include" param is a CSV of
            // category filters; we omit it entirely if every category is on
            // (cleaner URL).
            var includes = new List<string>();
            if (ChkCmdInfo?.IsChecked    == true) includes.Add("info");
            if (ChkCmdCustom?.IsChecked  == true) includes.Add("custom");
            if (ChkCmdCounter?.IsChecked == true) includes.Add("counter");
            if (ChkCmdBolts?.IsChecked   == true) includes.Add("bolts");
            if (ChkCmdClip?.IsChecked    == true) includes.Add("clip");
            if (ChkCmdCheckIn?.IsChecked == true) includes.Add("checkin");
            string includeCsv = (includes.Count == 6) ? null : string.Join(",", includes);

            // Cap rotate to a sane range; the overlay clamps to >= 6s anyway.
            var rotateText = (TxtCommandsRotate?.Text ?? "30").Trim();
            int rotateSec; if (!int.TryParse(rotateText, out rotateSec) || rotateSec < 10) rotateSec = 30;

            if (TxtUrlCommands != null)
            {
                TxtUrlCommands.Text = BuildOverlayUrl(baseUrl, "commands", secret, new Dictionary<string, string>
                {
                    ["pos"]       = SelectedTag(CmbCommandsPos),
                    ["theme"]     = SelectedTag(CmbCommandsTheme),
                    ["rotate"]    = rotateSec.ToString(),
                    ["include"]   = includeCsv,
                    ["accent"]    = NormalizeHex(TxtCommandsAccent?.Text),
                    ["bgOpacity"] = string.IsNullOrWhiteSpace(TxtCommandsBgOpacity?.Text) ? null : ClampInt(TxtCommandsBgOpacity.Text, 0, 100, 94)
                });
            }

            // End-of-stream recap card. Duration is in milliseconds at the
            // overlay layer, but for the UI we expose seconds (more natural).
            if (TxtUrlRecap != null)
            {
                int recapSec; if (!int.TryParse((TxtRecapDuration?.Text ?? "25").Trim(), out recapSec) || recapSec < 5) recapSec = 25;
                TxtUrlRecap.Text = BuildOverlayUrl(baseUrl, "recap", secret, new Dictionary<string, string>
                {
                    ["align"]     = SelectedTag(CmbRecapAlign),
                    ["duration"]  = (recapSec * 1000).ToString(),
                    ["accent"]    = NormalizeHex(TxtRecapAccent?.Text),
                    ["bgOpacity"] = string.IsNullOrWhiteSpace(TxtRecapBgOpacity?.Text) ? null : ClampInt(TxtRecapBgOpacity.Text, 0, 100, 94)
                });
            }

            // Viewer profile card (!profile @user).
            if (TxtUrlViewer != null)
            {
                int viewerSec; if (!int.TryParse((TxtViewerDuration?.Text ?? "10").Trim(), out viewerSec) || viewerSec < 3) viewerSec = 10;
                TxtUrlViewer.Text = BuildOverlayUrl(baseUrl, "viewer", secret, new Dictionary<string, string>
                {
                    ["align"]     = SelectedTag(CmbViewerAlign),
                    ["duration"]  = (viewerSec * 1000).ToString(),
                    ["accent"]    = NormalizeHex(TxtViewerAccent?.Text),
                    ["bgOpacity"] = string.IsNullOrWhiteSpace(TxtViewerBgOpacity?.Text) ? null : ClampInt(TxtViewerBgOpacity.Text, 0, 100, 94)
                });
            }

            // Cross-platform hype train.
            if (TxtUrlHypeTrain != null)
            {
                TxtUrlHypeTrain.Text = BuildOverlayUrl(baseUrl, "hypetrain", secret, new Dictionary<string, string>
                {
                    ["pos"]    = SelectedTag(CmbHypeTrainPos),
                    ["accent"] = NormalizeHex(TxtHypeTrainAccent?.Text)
                });
            }

            // Bolts minigames (coinflip / dice visualizer).
            if (TxtUrlMinigames != null)
            {
                TxtUrlMinigames.Text = BuildOverlayUrl(baseUrl, "minigames", secret, new Dictionary<string, string>
                {
                    ["pos"]    = SelectedTag(CmbMinigamesPos),
                    ["accent"] = NormalizeHex(TxtMinigamesAccent?.Text)
                });
            }

            // Rotation Spotify widget. Different URL shape than the
            // OBS overlays: lives at widget.aquilo.gg/rotation/<page>.html
            // and reads busUrl + busSecret from URL params on first load
            // (then persists them to localStorage). We bake both in so
            // the streamer's URL "just works" the moment they load it.
            if (TxtUrlRotation != null)
            {
                var rotBase = (TxtRotationBaseUrl?.Text ?? "").Trim();
                if (string.IsNullOrEmpty(rotBase)) rotBase = "https://widget.aquilo.gg/rotation";
                rotBase = rotBase.TrimEnd('/');
                var variant = SelectedTag(CmbRotationVariant);
                if (string.IsNullOrEmpty(variant)) variant = "widget";

                var qs = new List<string>
                {
                    "busUrl="    + HttpUtility.UrlEncode("ws://127.0.0.1:7470/aquilo/bus/")
                };
                if (!string.IsNullOrEmpty(secret))
                    qs.Add("busSecret=" + HttpUtility.UrlEncode(secret));
                TxtUrlRotation.Text = rotBase + "/" + variant + ".html?" + string.Join("&", qs);
            }

            // Compact one-pane overlay (commands ticker idle + crossfade
            // event cards when the bus fires something). Defaults are
            // dropped from the URL so the streamer's link stays compact.
            if (TxtUrlCompact != null)
            {
                string compactHold   = ClampInt(TxtCompactHoldMs?.Text, 1500, 30000, 4500);
                string compactIdle   = ClampInt(TxtCompactIdleRotate?.Text, 10, 600, 30);
                TxtUrlCompact.Text = BuildOverlayUrl(baseUrl, "compact", secret, new Dictionary<string, string>
                {
                    ["pos"]        = SelectedTag(CmbCompactPos),
                    ["holdMs"]     = compactHold == "4500" ? null : compactHold,
                    ["idleRotate"] = compactIdle == "30"   ? null : compactIdle
                });
            }

            // All-in-one composite. Picks up the layer checkboxes, builds a
            // CSV, and emits one URL the streamer drops into a single OBS
            // browser source. Each layer is an iframe of the standalone
            // overlay so per-overlay theming on the cards above stays in
            // effect inside the composite.
            if (TxtUrlAll != null)
            {
                var allLayers = new System.Collections.Generic.List<string>();
                if (ChkAllBolts?.IsChecked     == true) allLayers.Add("bolts");
                if (ChkAllCounters?.IsChecked  == true) allLayers.Add("counters");
                if (ChkAllGoals?.IsChecked     == true) allLayers.Add("goals");
                if (ChkAllCheckIn?.IsChecked   == true) allLayers.Add("check-in");
                if (ChkAllApex?.IsChecked      == true) allLayers.Add("apex");
                if (ChkAllCommands?.IsChecked  == true) allLayers.Add("commands");
                if (ChkAllRecap?.IsChecked     == true) allLayers.Add("recap");
                if (ChkAllViewer?.IsChecked    == true) allLayers.Add("viewer");
                if (ChkAllHypeTrain?.IsChecked == true) allLayers.Add("hypetrain");
                if (ChkAllMinigames?.IsChecked == true) allLayers.Add("minigames");

                TxtUrlAll.Text = BuildOverlayUrl(baseUrl, "all", secret, new Dictionary<string, string>
                {
                    ["layers"] = allLayers.Count == 10 ? null : string.Join(",", allLayers)
                });
            }
        }

        private string BuildOverlayUrl(string baseUrl, string overlay, string secret, Dictionary<string, string> extras)
        {
            var qs = new List<string>
            {
                "bus=" + HttpUtility.UrlEncode("ws://127.0.0.1:7470/aquilo/bus/")
            };
            if (!string.IsNullOrEmpty(secret)) qs.Add("secret=" + HttpUtility.UrlEncode(secret));

            // Global theme params (font / accent2 / fontScale / text) get
            // appended to every overlay URL when the streamer set them.
            // Per-overlay extras come last so a per-overlay accent
            // overrides whatever was on the global theme card.
            foreach (var kv in GlobalThemeParams())
                if (!string.IsNullOrEmpty(kv.Value)) qs.Add(kv.Key + "=" + HttpUtility.UrlEncode(kv.Value));

            if (extras != null)
                foreach (var kv in extras)
                    if (!string.IsNullOrEmpty(kv.Value)) qs.Add(kv.Key + "=" + HttpUtility.UrlEncode(kv.Value));
            // Trailing slash before the query string so Cloudflare Pages
            // serves <overlay>/index.html cleanly without relying on its
            // (configurable) extension-stripping/redirect behavior.
            return baseUrl + "/" + overlay + "/?" + string.Join("&", qs);
        }

        // Every per-overlay control on the Overlays tab whose value should
        // survive a Settings restart. Add new overlay cards here when
        // building them. The persistence helper below is type-agnostic
        // (TextBox / ComboBox / CheckBox handled uniformly) so the only
        // maintenance is keeping this list current.
        private static readonly string[] OverlayControlNames = new[]
        {
            // Global
            "TxtOverlayBaseUrl",
            // Check-in
            "CmbCheckInOverlayPos", "TxtCheckInAccent", "TxtCheckInBgOpacity",
            // Counters
            "CmbCountersTheme", "CmbCountersLayout", "TxtCountersAccent", "TxtCountersBgOpacity",
            // Goals
            "CmbGoalsTheme", "TxtGoalsAccent", "TxtGoalsBgOpacity",
            // Bolts
            "ChkLayerLeaderboard", "ChkLayerToast", "ChkLayerRain",
            "ChkLayerStreak", "ChkLayerGiftBurst", "ChkLayerWelcomes",
            "TxtBoltsAccent", "TxtBoltsLbRows", "TxtBoltsToastDur", "TxtBoltsBgOpacity",
            // Apex
            "CmbApexPos", "TxtApexAccent", "TxtApexBgOpacity",
            // Commands
            "CmbCommandsPos", "CmbCommandsTheme", "TxtCommandsRotate",
            "TxtCommandsAccent", "TxtCommandsBgOpacity",
            "ChkCmdInfo", "ChkCmdBolts", "ChkCmdCounters",
            "ChkCmdMod", "ChkCmdClip", "ChkCmdCheckIn",
            // Recap
            "CmbRecapAlign", "TxtRecapAccent", "TxtRecapDuration", "TxtRecapBgOpacity",
            // Viewer
            "CmbViewerAlign", "TxtViewerAccent", "TxtViewerDuration", "TxtViewerBgOpacity",
            // Hype train
            "CmbHypeTrainPos", "TxtHypeTrainAccent",
            // Minigames
            "CmbMinigamesPos", "TxtMinigamesAccent",
            // Compact (one-pane)
            "CmbCompactPos", "TxtCompactHoldMs", "TxtCompactIdleRotate",
            // Rotation widget (Spotify) connection card
            "CmbRotationVariant", "TxtRotationBaseUrl",
            // All-in-one composite layer toggles
            "ChkAllBolts", "ChkAllCounters", "ChkAllGoals", "ChkAllCheckIn",
            "ChkAllApex", "ChkAllCommands", "ChkAllRecap", "ChkAllViewer",
            "ChkAllHypeTrain", "ChkAllMinigames"
        };

        private void RestoreOverlayCardValues(Dictionary<string, string> values)
        {
            if (values == null || values.Count == 0) return;
            foreach (var name in OverlayControlNames)
            {
                if (!values.TryGetValue(name, out var v) || v == null) continue;
                var el = FindName(name) as FrameworkElement;
                if (el == null) continue;
                if (el is TextBox t) { t.Text = v; }
                else if (el is ComboBox c)
                {
                    foreach (ComboBoxItem item in c.Items)
                    {
                        if (string.Equals(item?.Tag?.ToString(), v, StringComparison.Ordinal))
                        { c.SelectedItem = item; break; }
                    }
                }
                else if (el is CheckBox cb) { cb.IsChecked = (v == "1"); }
            }
        }

        private void CaptureOverlayCardValues(Dictionary<string, string> sink)
        {
            if (sink == null) return;
            foreach (var name in OverlayControlNames)
            {
                var el = FindName(name) as FrameworkElement;
                if (el == null) continue;
                if (el is TextBox t)        sink[name] = t.Text ?? "";
                else if (el is ComboBox c)  sink[name] = (c.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
                else if (el is CheckBox cb) sink[name] = (cb.IsChecked == true) ? "1" : "0";
            }
        }

        private Dictionary<string, string> GlobalThemeParams()
        {
            var d = new Dictionary<string, string>();
            // Font family from the dropdown's Tag (empty Tag = "use overlay default").
            var fontTag = (CmbOverlayFont?.SelectedItem as ComboBoxItem)?.Tag?.ToString();
            if (!string.IsNullOrWhiteSpace(fontTag)) d["font"] = fontTag;

            // Font scale: only emit when ≠ 1.0 to keep URLs tidy.
            var scaleText = (TxtOverlayFontScale?.Text ?? "").Trim();
            if (!string.IsNullOrEmpty(scaleText) && scaleText != "1" && scaleText != "1.0"
                && double.TryParse(scaleText, out var sv) && sv > 0 && sv <= 3)
                d["fontScale"] = sv.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);

            var accent2 = NormalizeHex(TxtOverlayAccent2?.Text);
            if (!string.IsNullOrEmpty(accent2)) d["accent2"] = accent2;

            var text = NormalizeHex(TxtOverlayText?.Text);
            if (!string.IsNullOrEmpty(text)) d["text"] = text;

            return d;
        }

        private static string SelectedTag(ComboBox cb) =>
            (cb?.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";

        // Strip leading '#', validate 3- or 6-char hex, uppercase. Returns ""
        // for empty/invalid input so BuildOverlayUrl drops the param entirely
        // rather than emitting a broken URL.
        private static string NormalizeHex(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return "";
            var t = s.Trim().TrimStart('#');
            if (t.Length != 3 && t.Length != 6) return "";
            for (int i = 0; i < t.Length; i++)
            {
                var c = t[i];
                if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f')))
                    return "";
            }
            return t.ToUpperInvariant();
        }

        // Parse + clamp an integer. Returns the clamped value as a string, or
        // the fallback if the input doesn't parse. Used by overlay theme inputs
        // so the URL builder never emits out-of-range values.
        private static string ClampInt(string s, int min, int max, int fallback)
        {
            int v;
            if (!int.TryParse((s ?? "").Trim(), out v)) v = fallback;
            if (v < min) v = min;
            if (v > max) v = max;
            return v.ToString();
        }

        private static string TryReadBusSecret()
        {
            try
            {
                var path = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "Aquilo", "bus-secret.txt");
                return File.Exists(path) ? File.ReadAllText(path).Trim() : "(bus not started yet - boot Loadout first)";
            }
            catch { return ""; }
        }

        private void BtnCopyBusSecret_Click(object sender, RoutedEventArgs e)
        {
            try { Clipboard.SetText(TxtBusSecret.Text ?? ""); ShowSavedHint("Bus secret copied."); }
            catch (Exception ex) { ShowSavedHint("Copy failed: " + ex.Message); }
        }

        // Upload handler for the "Custom badge icons" rows. Pops a file
        // picker for the chosen category (Tag), reads the image bytes,
        // base64-encodes into a data: URL, and stuffs the result into
        // the matching TextBox. The data URL flows through Save +
        // CommandsBroadcaster.Publish to overlays via commands.icons.
        // Cap the image at 64 KB so a 4-megapixel screenshot doesn't
        // bloat settings.json into a multi-MB file.
        private void BtnIconUpload_Click(object sender, RoutedEventArgs e)
        {
            const int MaxBytes = 64 * 1024;
            var cat = (sender as Button)?.Tag?.ToString();
            if (string.IsNullOrEmpty(cat)) return;
            TextBox target = null;
            switch (cat)
            {
                case "info":    target = TxtIconInfo;    break;
                case "custom":  target = TxtIconCustom;  break;
                case "bolts":   target = TxtIconBolts;   break;
                case "clip":    target = TxtIconClip;    break;
                case "checkin": target = TxtIconCheckin; break;
                case "counter": target = TxtIconCounter; break;
                case "mod":     target = TxtIconMod;     break;
                case "song":    target = TxtIconSong;    break;
            }
            if (target == null) return;

            var dlg = new Microsoft.Win32.OpenFileDialog
            {
                Title  = "Pick a badge image (PNG / JPG / WebP, ≤ 64 KB)",
                Filter = "Images (*.png;*.jpg;*.jpeg;*.gif;*.webp)|*.png;*.jpg;*.jpeg;*.gif;*.webp|All files (*.*)|*.*"
            };
            if (dlg.ShowDialog(this) != true) return;

            try
            {
                var bytes = File.ReadAllBytes(dlg.FileName);
                if (bytes.Length > MaxBytes)
                {
                    System.Windows.MessageBox.Show(this,
                        "That image is " + (bytes.Length / 1024) + " KB — keep it under " +
                        (MaxBytes / 1024) + " KB so the bus payload stays snappy. Try a smaller PNG / WebP.",
                        "Image too large", System.Windows.MessageBoxButton.OK,
                        System.Windows.MessageBoxImage.Warning);
                    return;
                }
                var ext = (Path.GetExtension(dlg.FileName) ?? "").ToLowerInvariant().TrimStart('.');
                var mime = ext == "jpg" ? "jpeg" : ext;
                if (string.IsNullOrEmpty(mime)) mime = "png";
                var b64 = Convert.ToBase64String(bytes);
                target.Text = "data:image/" + mime + ";base64," + b64;
                ShowSavedHint("Loaded " + cat + " icon (" + (bytes.Length / 1024) + " KB). Save to apply.");
            }
            catch (Exception ex)
            {
                System.Windows.MessageBox.Show(this, "Couldn't read that file: " + ex.Message,
                    "Upload failed", System.Windows.MessageBoxButton.OK,
                    System.Windows.MessageBoxImage.Error);
            }
        }

        private void BtnOverlayCopy_Click(object sender, RoutedEventArgs e)
        {
            var tag = (sender as Button)?.Tag?.ToString();
            var url = OverlayUrlByTag(tag);
            if (string.IsNullOrEmpty(url)) return;
            try { Clipboard.SetText(url); ShowSavedHint("URL copied: " + tag); }
            catch (Exception ex) { ShowSavedHint("Copy failed: " + ex.Message); }
        }

        private void BtnOverlayOpen_Click(object sender, RoutedEventArgs e)
        {
            var tag = (sender as Button)?.Tag?.ToString();
            var url = OverlayUrlByTag(tag);
            if (string.IsNullOrEmpty(url)) return;
            try
            {
                // UseShellExecute=true routes the URL through the default browser
                // on modern .NET. Note: a regular browser tab will likely show a
                // blank page because https → ws://127.0.0.1 is mixed-content
                // blocked. The overlay still works in OBS browser sources (those
                // don't enforce mixed-content). Use "Send test" instead to fire
                // a sample event into the OBS source for placement testing.
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url)
                {
                    UseShellExecute = true
                });
                ShowSavedHint("Opened " + tag + " URL in browser.");
            }
            catch (Exception ex) { ShowSavedHint("Open failed: " + ex.Message); }
        }

        // Fires a sample event of the overlay's subscribed kind into the
        // Aquilo Bus. Any OBS browser source already attached to the bus
        // for that overlay renders the test content, letting the streamer
        // size + position the source against real-shape sample data.
        private void BtnOverlaySendTest_Click(object sender, RoutedEventArgs e)
        {
            var tag = (sender as Button)?.Tag?.ToString();
            if (string.IsNullOrEmpty(tag)) return;
            try
            {
                FireOverlayTestEvent(tag);
                ShowSavedHint("Sent test " + tag + " to overlay (check OBS).");
            }
            catch (Exception ex) { ShowSavedHint("Send failed: " + ex.Message); }
        }

        // Publishes one event of the right kind for each overlay so its
        // page renders something. Each kind here matches the overlay's
        // own subscribe list in main.js — keep them in sync if either
        // side changes.
        private void FireOverlayTestEvent(string tag)
        {
            var s = SettingsManager.Instance.Current;
            var sampleUser = s.BroadcasterName ?? "test_user";

            try
            {
                switch (tag)
                {
                    case "bolts":
                        AquiloBus.Instance.Publish("bolts.leaderboard", new
                        {
                            top = new[]
                            {
                                new { handle = sampleUser,                balance = 12450 },
                                new { handle = sampleUser + "_friend",    balance = 8200  },
                                new { handle = "viewer_three",            balance = 5410  },
                                new { handle = "viewer_four",             balance = 1100  },
                                new { handle = "viewer_five",             balance = 920   }
                            }
                        });
                        AquiloBus.Instance.Publish("bolts.earned",  new { user = sampleUser, amount = 250 });
                        AquiloBus.Instance.Publish("bolts.streak",  new { user = sampleUser, streakDays = 12 });
                        break;

                    case "check-in":
                    case "checkin:viewer":
                    case "checkin:sub-t1":
                    case "checkin:sub-t2":
                    case "checkin:sub-t3":
                    case "checkin:vip":
                    case "checkin:mod":
                    case "checkin:patreon-t2":
                    case "checkin:patreon-t3":
                    case "checkin:tiktok-fan-club":
                    case "checkin:yt-member":
                    case "checkin:kick-sub":
                    case "checkin:raider":
                    case "checkin:first":
                        // Resolve viewer-type knobs from the tag so the
                        // streamer can preview every flair variant. The
                        // overlay reads role / subTier / patreonTier /
                        // platform / showFlairs to decide what badges
                        // to render around the avatar.
                        string ciRole = "viewer", ciSubTier = null, ciPatreon = null, ciPlatform = "twitch";
                        string ciFan = null;   // tiktok fan-club tier name
                        string ciExtraStat = null;
                        bool isFirstTime = false;
                        switch (tag)
                        {
                            case "checkin:sub-t1":          ciRole = "sub"; ciSubTier = "1000"; break;
                            case "checkin:sub-t2":          ciRole = "sub"; ciSubTier = "2000"; break;
                            case "checkin:sub-t3":          ciRole = "sub"; ciSubTier = "3000"; break;
                            case "checkin:vip":             ciRole = "vip"; break;
                            case "checkin:mod":             ciRole = "moderator"; break;
                            case "checkin:patreon-t2":      ciRole = "viewer"; ciPatreon = "tier2"; break;
                            case "checkin:patreon-t3":      ciRole = "viewer"; ciPatreon = "tier3"; break;
                            case "checkin:tiktok-fan-club": ciRole = "fan-club"; ciPlatform = "tiktok"; ciFan = "level3"; break;
                            case "checkin:yt-member":       ciRole = "member"; ciPlatform = "youtube"; break;
                            case "checkin:kick-sub":        ciRole = "sub"; ciSubTier = "1000"; ciPlatform = "kick"; break;
                            case "checkin:raider":          ciRole = "raider"; ciExtraStat = "raid:from "+sampleUser+"_friend ×42"; break;
                            case "checkin:first":           ciRole = "viewer"; isFirstTime = true; break;
                            // "checkin:viewer" + "check-in" fall through with defaults
                        }

                        // Build the stats list — first-time gets a dedicated
                        // "first time here" stat instead of generic counters.
                        var ciStats = new System.Collections.Generic.List<object>
                        {
                            new { kind = "uptime",  label = "Uptime",  value = "1:23:45" },
                            new { kind = "viewers", label = "Viewers", value = "127" },
                            new { kind = "counter", label = "Deaths",  value = "12" }
                        };
                        if (isFirstTime)
                            ciStats.Insert(0, new { kind = "first", label = "First time", value = "👋 welcome!" });
                        if (ciExtraStat != null)
                            ciStats.Insert(0, new { kind = "raid", label = "Raid", value = ciExtraStat });

                        AquiloBus.Instance.Publish("checkin.shown", new
                        {
                            user           = isFirstTime ? sampleUser + "_new" : sampleUser,
                            userId         = "test",
                            platform       = ciPlatform,
                            role           = ciRole,
                            subTier        = ciSubTier,
                            patreonTier    = ciPatreon,
                            tikTokFanClub  = ciFan,
                            firstTime      = isFirstTime,
                            pfp            = (string)null,
                            animationTheme = s.CheckIn.AnimationTheme,
                            showFlairs     = new { sub = s.CheckIn.ShowSubFlair, vipMod = s.CheckIn.ShowVipModFlair, patreon = s.CheckIn.ShowPatreonFlair },
                            stats          = ciStats.ToArray(),
                            rotateSeconds  = s.CheckIn.RotateIntervalSec,
                            source         = "test",
                            ts             = DateTime.UtcNow
                        });
                        break;

                    case "counters":
                        AquiloBus.Instance.Publish("counter.updated", new
                        {
                            name    = "deaths",
                            display = "Deaths",
                            value   = 12,
                            ts      = DateTime.UtcNow
                        });
                        AquiloBus.Instance.Publish("counter.updated", new
                        {
                            name    = "wins",
                            display = "Wins",
                            value   = 7,
                            ts      = DateTime.UtcNow
                        });
                        break;

                    case "goals":
                        AquiloBus.Instance.Publish("goal.advanced", new
                        {
                            name    = "Sub goal",
                            kind    = "subs",
                            target  = 100,
                            current = 47,
                            ts      = DateTime.UtcNow
                        });
                        break;

                    case "apex":
                        AquiloBus.Instance.Publish("apex.crowned", new
                        {
                            topUser   = sampleUser,
                            health    = 850,
                            maxHealth = 1000,
                            ts        = DateTime.UtcNow
                        });
                        AquiloBus.Instance.Publish("apex.state", new
                        {
                            topUser   = sampleUser,
                            health    = 850,
                            maxHealth = 1000,
                            ts        = DateTime.UtcNow
                        });
                        break;

                    case "commands":
                        // Overlay reads payload.commands (with cat field) and
                        // rotates between them. Match the shape that
                        // CommandsBroadcaster.Publish emits at runtime.
                        AquiloBus.Instance.Publish("commands.list", new
                        {
                            commands = new object[]
                            {
                                new { name = "!uptime",     desc = "how long the stream has been live", cat = "info" },
                                new { name = "!discord",    desc = "join the streamer's Discord",       cat = "info" },
                                new { name = "!socials",    desc = "find me everywhere",                cat = "info" },
                                new { name = "!commands",   desc = "list every command available",      cat = "info" },
                                new { name = "!balance",    desc = "check your bolts balance",          cat = "bolts" },
                                new { name = "!leaderboard",desc = "top bolts holders",                 cat = "bolts" },
                                new { name = "!clip",       desc = "clip the last moment",              cat = "clip" },
                                new { name = "!checkin",    desc = "daily check-in",                    cat = "checkin" }
                            },
                            ts = DateTime.UtcNow
                        });
                        break;

                    case "recap":
                        AquiloBus.Instance.Publish("recap.posted", new
                        {
                            title = "Stream wrap",
                            stats = new object[]
                            {
                                new { label = "Stream length", value = "3:42" },
                                new { label = "Peak viewers",  value = "127"  },
                                new { label = "New followers", value = "+12"  },
                                new { label = "New subs",      value = "+3"   },
                                new { label = "Bits cheered",  value = "850"  }
                            },
                            ts = DateTime.UtcNow
                        });
                        break;

                    case "viewer":
                        AquiloBus.Instance.Publish("viewer.profile.shown", new
                        {
                            user       = sampleUser,
                            platform   = "twitch",
                            bolts      = 12450,
                            streakDays = 7,
                            firstSeen  = "Mar 2024",
                            ts         = DateTime.UtcNow
                        });
                        break;

                    case "hypetrain":
                        // Fire start → contribute → level-up so the overlay
                        // animates through the full life cycle in one click.
                        AquiloBus.Instance.Publish("hypetrain.start", new
                        {
                            level = 1, fuel = 60, threshold = 100, maxLevel = 5,
                            fromUser = sampleUser, kind = "cheer", ts = DateTime.UtcNow
                        });
                        AquiloBus.Instance.Publish("hypetrain.contribute", new
                        {
                            user = sampleUser + "_friend", kind = "tiktokGift",
                            fuel = 30, totalFuel = 90, level = 1, threshold = 100,
                            ts = DateTime.UtcNow
                        });
                        AquiloBus.Instance.Publish("hypetrain.level", new
                        {
                            level = 2, fuel = 120, threshold = 100, maxLevel = 5,
                            fromUser = "viewer_three", kind = "giftSub", ts = DateTime.UtcNow
                        });
                        break;

                    case "minigames":
                        // Fire a coinflip, dice, and a slots jackpot in
                        // succession so the overlay animates each in turn
                        // (each visualization auto-hides after ~3-4s).
                        AquiloBus.Instance.Publish("bolts.minigame.coinflip", new
                        {
                            user    = sampleUser,
                            wager   = 50,
                            result  = "heads",
                            won     = true,
                            payout  = 100,
                            balance = 1250,
                            ts      = DateTime.UtcNow
                        });
                        AquiloBus.Instance.Publish("bolts.minigame.dice", new
                        {
                            user    = sampleUser + "_friend",
                            wager   = 25,
                            target  = 6,
                            rolled  = 3,
                            won     = false,
                            payout  = 0,
                            balance = 920,
                            ts      = DateTime.UtcNow
                        });
                        // Slots jackpot — 3 same. Reels and pool are Twitch
                        // global emote URLs so the overlay's reel animation
                        // has real images to cycle / land on.
                        var jackpotEmote = "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0";
                        AquiloBus.Instance.Publish("bolts.minigame.slots", new
                        {
                            user    = sampleUser,
                            wager   = 100,
                            reels   = new[] { jackpotEmote, jackpotEmote, jackpotEmote },
                            won     = true,
                            payout  = 500,
                            balance = 1750,
                            pool    = new[]
                            {
                                "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
                                "https://static-cdn.jtvnw.net/emoticons/v2/86/default/dark/2.0",
                                "https://static-cdn.jtvnw.net/emoticons/v2/354/default/dark/2.0",
                                "https://static-cdn.jtvnw.net/emoticons/v2/245/default/dark/2.0",
                                "https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/2.0",
                                "https://static-cdn.jtvnw.net/emoticons/v2/305954156/default/dark/2.0"
                            },
                            ts = DateTime.UtcNow
                        });
                        break;

                    // Per-game test events so the streamer can preview each
                    // visualization in isolation (handy when tweaking the
                    // SlotsImagePool emoji/url mix or the dice/coinflip
                    // colors without re-firing the other two).
                    case "coinflip":
                    case "minigames-coinflip":
                        AquiloBus.Instance.Publish("bolts.minigame.coinflip", new
                        {
                            user    = sampleUser,
                            wager   = 50,
                            result  = (DateTime.UtcNow.Millisecond % 2 == 0) ? "heads" : "tails",
                            won     = (DateTime.UtcNow.Millisecond % 2 == 0),
                            payout  = (DateTime.UtcNow.Millisecond % 2 == 0) ? 100 : 0,
                            balance = 1250,
                            source  = "test",
                            ts      = DateTime.UtcNow
                        });
                        break;

                    case "dice":
                    case "minigames-dice":
                    {
                        var rolled = (DateTime.UtcNow.Millisecond % 6) + 1;
                        var target = 6;
                        var won    = (rolled == target);
                        AquiloBus.Instance.Publish("bolts.minigame.dice", new
                        {
                            user    = sampleUser,
                            wager   = 25,
                            target  = target,
                            rolled  = rolled,
                            won     = won,
                            payout  = won ? 125 : 0,
                            balance = 920,
                            source  = "test",
                            ts      = DateTime.UtcNow
                        });
                        break;
                    }

                    case "slots":
                    case "minigames-slots":
                    {
                        // Build the test from the user's actual configured pool
                        // so emoji entries get exercised. Fall back to the
                        // built-in default if the pool is empty.
                        string[] pool;
                        var raw = (s.Bolts.SlotsImagePool ?? "").Replace("\r\n", "\n");
                        var lines = raw.Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
                        var trimmed = new List<string>();
                        foreach (var l in lines) { var t = l.Trim(); if (t.Length > 0) trimmed.Add(t); }
                        if (trimmed.Count >= 3) pool = trimmed.ToArray();
                        else pool = new[]
                        {
                            "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
                            "https://static-cdn.jtvnw.net/emoticons/v2/86/default/dark/2.0",
                            "https://static-cdn.jtvnw.net/emoticons/v2/354/default/dark/2.0",
                            "https://static-cdn.jtvnw.net/emoticons/v2/245/default/dark/2.0",
                            "https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/2.0",
                            "https://static-cdn.jtvnw.net/emoticons/v2/305954156/default/dark/2.0"
                        };
                        // Pick a jackpot reel from the pool every other test
                        // and a non-match the alternate time so the streamer
                        // can preview both win and lose visuals.
                        bool jackpot = (DateTime.UtcNow.Second % 2 == 0);
                        var rng = new Random();
                        string[] reels;
                        if (jackpot)
                        {
                            var pick = pool[rng.Next(pool.Length)];
                            reels = new[] { pick, pick, pick };
                        }
                        else
                        {
                            reels = new[]
                            {
                                pool[rng.Next(pool.Length)],
                                pool[rng.Next(pool.Length)],
                                pool[rng.Next(pool.Length)]
                            };
                        }
                        AquiloBus.Instance.Publish("bolts.minigame.slots", new
                        {
                            user    = sampleUser,
                            wager   = 100,
                            reels   = reels,
                            won     = jackpot,
                            payout  = jackpot ? 500 : 0,
                            balance = jackpot ? 1750 : 1150,
                            pool    = pool,
                            source  = "test",
                            ts      = DateTime.UtcNow
                        });
                        break;
                    }

                    case "rotation":
                        // Synthetic now-playing event so the streamer can verify
                        // their compact overlay + !song chat reply without
                        // waiting on Spotify to actually change tracks.
                        AquiloBus.Instance.Publish("rotation.song.playing", new
                        {
                            title         = "Sample Track",
                            artist        = "Aquilo Test Artist",
                            album         = "Loadout Demo",
                            art           = (string)null,
                            durationMs    = 215000,
                            progressMs    = 47000,
                            source        = "Spotify",
                            trackId       = "test-track-id",
                            isPlaying     = true,
                            requestedBy   = (string)null,
                            requesterPlatform = (string)null,
                            ts            = DateTime.UtcNow
                        });
                        break;

                    case "compact":
                        // Compact overlay listens broadly. Fire a sample of
                        // the kinds it cares about so the streamer can
                        // preview the full crossfade behaviour: a commands
                        // tick (free, just from the idle source), then an
                        // event from each major bucket spread out in time
                        // so the queue + crossfade is exercised.
                        AquiloBus.Instance.Publish("commands.list", new
                        {
                            commands = new object[]
                            {
                                new { name = "!uptime",    desc = "how long the stream has been live", cat = "info" },
                                new { name = "!balance",   desc = "check your bolts balance",          cat = "bolts" },
                                new { name = "!discord",   desc = "join the streamer's Discord",       cat = "info" },
                                new { name = "!leaderboard", desc = "top bolts holders",               cat = "bolts" },
                                new { name = "!clip",      desc = "clip the last moment",              cat = "clip" }
                            },
                            ts = DateTime.UtcNow
                        });
                        AquiloBus.Instance.Publish("bolts.earned", new { user = sampleUser, amount = 50, source = "test", ts = DateTime.UtcNow });
                        // Welcome a beat later, then counter, hype, minigame.
                        // Each lands while the previous holds, queueing
                        // through the overlay's pump.
                        var compactScheduler = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1200) };
                        var compactStep = 0;
                        compactScheduler.Tick += (_, __) =>
                        {
                            compactStep++;
                            if (compactStep == 1)
                                AquiloBus.Instance.Publish("welcome.fired", new { user = sampleUser + "_friend", userType = "firstTime", platform = "twitch", rendered = "👋 Welcome " + sampleUser + "_friend, glad you found us!", source = "test", ts = DateTime.UtcNow });
                            else if (compactStep == 2)
                                AquiloBus.Instance.Publish("counter.updated", new { name = "deaths", display = "Deaths", value = 12, ts = DateTime.UtcNow });
                            else if (compactStep == 3)
                                AquiloBus.Instance.Publish("hypetrain.contribute", new { user = "viewer_three", kind = "tiktokGift", fuel = 30, totalFuel = 90, level = 1, threshold = 100, ts = DateTime.UtcNow });
                            else if (compactStep == 4)
                                AquiloBus.Instance.Publish("bolts.minigame.coinflip", new { user = sampleUser, wager = 50, result = "heads", won = true, payout = 50, source = "test", ts = DateTime.UtcNow });
                            else
                                compactScheduler.Stop();
                        };
                        compactScheduler.Start();
                        break;

                    case "all":
                        // Composite test: fire each enabled layer's test
                        // event so the all-in-one overlay renders the lot.
                        if (ChkAllBolts?.IsChecked     == true) FireOverlayTestEvent("bolts");
                        if (ChkAllCounters?.IsChecked  == true) FireOverlayTestEvent("counters");
                        if (ChkAllGoals?.IsChecked     == true) FireOverlayTestEvent("goals");
                        if (ChkAllCheckIn?.IsChecked   == true) FireOverlayTestEvent("check-in");
                        if (ChkAllApex?.IsChecked      == true) FireOverlayTestEvent("apex");
                        if (ChkAllCommands?.IsChecked  == true) FireOverlayTestEvent("commands");
                        if (ChkAllRecap?.IsChecked     == true) FireOverlayTestEvent("recap");
                        if (ChkAllViewer?.IsChecked    == true) FireOverlayTestEvent("viewer");
                        if (ChkAllHypeTrain?.IsChecked == true) FireOverlayTestEvent("hypetrain");
                        if (ChkAllMinigames?.IsChecked == true) FireOverlayTestEvent("minigames");
                        break;
                }
            }
            catch { /* publish is best-effort; the browser open already succeeded */ }
        }

        private string OverlayUrlByTag(string tag)
        {
            switch (tag)
            {
                case "check-in": return TxtUrlCheckIn?.Text;
                case "counters": return TxtUrlCounters?.Text;
                case "goals":    return TxtUrlGoals?.Text;
                case "bolts":    return TxtUrlBolts?.Text;
                case "apex":     return TxtUrlApex?.Text;
                case "commands": return TxtUrlCommands?.Text;
                case "recap":    return TxtUrlRecap?.Text;
                case "viewer":    return TxtUrlViewer?.Text;
                case "hypetrain": return TxtUrlHypeTrain?.Text;
                case "minigames": return TxtUrlMinigames?.Text;
                case "compact":   return TxtUrlCompact?.Text;
                case "rotation":  return TxtUrlRotation?.Text;
                case "all":       return TxtUrlAll?.Text;
                default:         return null;
            }
        }

        // ── Game profiles tab ────────────────────────────────────────────────

        private void BindGameProfilesTab()
        {
            _gameProfiles.Clear();
            var s = SettingsManager.Instance.Current;
            if (s.GameProfiles?.Profiles != null)
                foreach (var p in s.GameProfiles.Profiles) _gameProfiles.Add(p);
            GrdGameProfiles.ItemsSource = _gameProfiles;
            ChkGameProfilesEnabled.IsChecked = s.GameProfiles?.Enabled ?? false;
        }
        private void BtnGameProfileAdd_Click(object sender, RoutedEventArgs e)
        {
            _gameProfiles.Add(new GameProfile { GameName = "Game name", WelcomeFirstTime = "", WelcomeSub = "", ActiveTimerGroups = "" });
            GrdGameProfiles.SelectedItem = _gameProfiles[_gameProfiles.Count - 1];
        }
        private void BtnGameProfileRemove_Click(object sender, RoutedEventArgs e)
        {
            if (GrdGameProfiles.SelectedItem is GameProfile p && ConfirmRemove("game profile")) _gameProfiles.Remove(p);
        }

        // ── Channel points tab ───────────────────────────────────────────────

        // Bound from the channel-points DataGrid's ComboBox via
        // {Binding RelativeSource={RelativeSource AncestorType=Window}, Path=TwitchRewardNames}.
        // Filled from CPH.TwitchGetRewards on demand by the Refresh button;
        // empty until then so the ComboBox falls back to free-text entry.
        public System.Collections.ObjectModel.ObservableCollection<string> TwitchRewardNames { get; } =
            new System.Collections.ObjectModel.ObservableCollection<string>();

        private void BindChannelPointsTab()
        {
            _channelPoints.Clear();
            var s = SettingsManager.Instance.Current;
            if (s.ChannelPoints?.Mappings != null)
                foreach (var m in s.ChannelPoints.Mappings) _channelPoints.Add(m);
            GrdChannelPoints.ItemsSource = _channelPoints;
            ChkChannelPointsEnabled.IsChecked = s.ChannelPoints?.Enabled ?? false;

            // Try a silent first pull — populates the dropdown if Twitch is
            // already connected on SB's side. Failure is fine; the user can
            // hit "Pull rewards from Twitch" manually after connecting.
            if (TwitchRewardNames.Count == 0)
            {
                try { RefreshTwitchRewards(silent: true); } catch { }
            }
        }

        private void RefreshTwitchRewards(bool silent = false)
        {
            var titles = Loadout.Platforms.CphPlatformSender.Instance.GetTwitchRewardTitles();
            TwitchRewardNames.Clear();
            foreach (var t in titles) TwitchRewardNames.Add(t);
            if (!silent)
            {
                ShowSavedHint(titles.Count > 0
                    ? "Pulled " + titles.Count + " reward(s) from Twitch."
                    : "No rewards returned — is Twitch connected in Streamer.bot?");
            }
        }

        private void BtnRefreshTwitchRewards_Click(object sender, RoutedEventArgs e)
        {
            RefreshTwitchRewards(silent: false);
        }
        private void BtnChannelPointAdd_Click(object sender, RoutedEventArgs e)
        {
            _channelPoints.Add(new ChannelPointMapping { RewardName = "Reward name", Action = "chat:Hello {user}!", Enabled = true });
            GrdChannelPoints.SelectedItem = _channelPoints[_channelPoints.Count - 1];
        }
        private void BtnChannelPointRemove_Click(object sender, RoutedEventArgs e)
        {
            if (GrdChannelPoints.SelectedItem is ChannelPointMapping m && ConfirmRemove("channel-point reward mapping")) _channelPoints.Remove(m);
        }

        // ── Backup tab ───────────────────────────────────────────────────────

        private void BtnBackupExport_Click(object sender, RoutedEventArgs e)
        {
            var dlg = new SaveFileDialog
            {
                FileName = "loadout-backup-" + DateTime.Now.ToString("yyyy-MM-dd") + ".zip",
                Filter   = "Loadout backup (*.zip)|*.zip|All files (*.*)|*.*",
                AddExtension = true,
                DefaultExt = ".zip"
            };
            if (dlg.ShowDialog(this) != true) return;
            try
            {
                var n = BackupManager.Export(dlg.FileName);
                TxtBackupStatus.Text = "Exported " + n + " files to " + dlg.FileName;
                ShowSavedHint("Backup written.");
            }
            catch (Exception ex)
            {
                TxtBackupStatus.Text = "Export failed: " + ex.Message;
            }
        }
        private void BtnBackupImport_Click(object sender, RoutedEventArgs e)
        {
            var confirm = MessageBox.Show(this,
                "Restoring a backup overwrites your current settings, counters, and wallet data with whatever's in the .zip. " +
                "Pre-existing files NOT in the backup are kept. Continue?",
                "Restore Loadout backup", MessageBoxButton.OKCancel, MessageBoxImage.Warning);
            if (confirm != MessageBoxResult.OK) return;

            var dlg = new OpenFileDialog
            {
                Filter = "Loadout backup (*.zip)|*.zip|All files (*.*)|*.*",
                CheckFileExists = true
            };
            if (dlg.ShowDialog(this) != true) return;
            try
            {
                var n = BackupManager.Import(dlg.FileName);
                TxtBackupStatus.Text = "Restored " + n + " files from " + dlg.FileName + ". Reloading window state...";
                // Re-bind everything from disk so the UI shows the imported settings.
                LoadFromSettings();
                BindCountersAndCheckIn();
                BindAlertsTab();
                BindTimersTab();
                BindGoalsTab();
                BindWebhooksTab();
                BindCustomCommandsTab();
                BindGameProfilesTab();
                BindChannelPointsTab();
                BindGamesTab();
                ShowSavedHint("Backup restored.");
            }
            catch (Exception ex)
            {
                TxtBackupStatus.Text = "Restore failed: " + ex.Message;
            }
        }

        // ── Log tab ──────────────────────────────────────────────────────────

        private void BindLogTab() => RefreshLogTail();
        private void RefreshLogTail()
        {
            var path = LogTail.ErrorLogPath;
            TxtLogTail.Text = LogTail.ReadTail(path, 200);
        }
        private void BtnLogRefresh_Click(object sender, RoutedEventArgs e) => RefreshLogTail();
        private void BtnLogOpen_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                var folder = SettingsManager.Instance.DataFolder;
                if (!string.IsNullOrEmpty(folder)) System.Diagnostics.Process.Start("explorer.exe", folder);
            }
            catch (Exception ex) { ShowSavedHint("Open folder failed: " + ex.Message); }
        }
        private void BtnLogClear_Click(object sender, RoutedEventArgs e)
        {
            var path = LogTail.ErrorLogPath;
            if (LogTail.Clear(path)) RefreshLogTail();
            else ShowSavedHint("Couldn't clear log (file in use).");
        }

        // ── Discord bot tab ──────────────────────────────────────────────────

        private System.Windows.Threading.DispatcherTimer _claimPollTimer;

        private void BindDiscordBotTab()
        {
            var d = SettingsManager.Instance.Current.DiscordBot;
            ChkDiscordBotEnabled.IsChecked = d.Enabled;
            TxtDcbWorkerUrl.Text   = d.WorkerUrl ?? "";
            TxtDcbGuildId.Text     = string.IsNullOrEmpty(d.GuildId) ? "(not bound yet)" : d.GuildId;
            TxtDcbAutoSync.Text    = d.AutoSyncMinutes.ToString();
            TxtDcbClaimCode.Text   = d.PendingClaimCode ?? "";
            switch ((d.SyncMode ?? "merge").ToLowerInvariant())
            {
                case "push": CmbDcbSyncMode.SelectedIndex = 1; break;
                case "pull": CmbDcbSyncMode.SelectedIndex = 2; break;
                default:     CmbDcbSyncMode.SelectedIndex = 0; break;
            }
            TxtDcbStatus.Text = string.IsNullOrEmpty(d.LastSyncStatus)
                ? (string.IsNullOrEmpty(d.GuildId) ? "Not bound yet — invite the bot, then claim." : "Bound to guild " + d.GuildId)
                : "Last: " + d.LastSyncUtc.ToLocalTime().ToString("g") + " - " + d.LastSyncStatus;
        }

        // Persist the form state before talking to the worker.
        private void StashDiscordFromUi()
        {
            SettingsManager.Instance.Mutate(cfg =>
            {
                cfg.DiscordBot.Enabled   = ChkDiscordBotEnabled.IsChecked == true;
                cfg.DiscordBot.WorkerUrl = (TxtDcbWorkerUrl.Text ?? "").Trim();
                cfg.DiscordBot.SyncMode  = ((ComboBoxItem)CmbDcbSyncMode.SelectedItem)?.Tag?.ToString() ?? "merge";
                if (int.TryParse(TxtDcbAutoSync.Text, out var m) && m >= 0)
                    cfg.DiscordBot.AutoSyncMinutes = m;
            });
            SettingsManager.Instance.SaveNow();
        }

        private async void BtnDcbMintCode_Click(object sender, RoutedEventArgs e)
        {
            StashDiscordFromUi();
            TxtDcbClaimHint.Text = "Asking worker for a fresh code...";
            var r = await DiscordSync.Instance.MintClaimCodeAsync();
            if (!r.Ok) { TxtDcbClaimHint.Text = "Failed: " + r.Message; return; }
            TxtDcbClaimCode.Text = r.Code;
            TxtDcbClaimHint.Text =
                "Type  /loadout-claim " + r.Code + "  in your Discord server. " +
                "Code expires in " + (r.ExpiresInSec / 60) + " minutes.";
            // Start polling for claim status. Stops on success / expiry.
            StartClaimPolling();
        }

        private void BtnDcbCopyCode_Click(object sender, RoutedEventArgs e)
        {
            try { Clipboard.SetText(TxtDcbClaimCode.Text ?? ""); ShowSavedHint("Code copied."); }
            catch (Exception ex) { ShowSavedHint("Copy failed: " + ex.Message); }
        }

        private void BtnDcbOpenInvite_Click(object sender, RoutedEventArgs e)
        {
            // Public invite URL for the shared "Loadout" bot. Self-hosters
            // override by changing the WorkerUrl AND minting their own bot -
            // in that case they should ignore this button. Permissions:
            // Send Messages + Embed Links + Use Application Commands = 2147502080.
            const string url = "https://discord.com/oauth2/authorize?client_id=1500849448866025573&permissions=2147502080&scope=bot+applications.commands";
            try { System.Diagnostics.Process.Start(url); }
            catch (Exception ex) { ShowSavedHint("Open failed: " + ex.Message); }
        }

        private void StartClaimPolling()
        {
            if (_claimPollTimer == null)
            {
                _claimPollTimer = new System.Windows.Threading.DispatcherTimer
                {
                    Interval = TimeSpan.FromSeconds(3)
                };
                _claimPollTimer.Tick += async (s, e) =>
                {
                    var (claimed, guildId, message) = await DiscordSync.Instance.PollClaimAsync();
                    if (claimed)
                    {
                        _claimPollTimer.Stop();
                        TxtDcbClaimHint.Text = "✓ Server claimed: " + guildId + ". You're set.";
                        BindDiscordBotTab();
                    }
                    else if (message == "expired")
                    {
                        _claimPollTimer.Stop();
                        TxtDcbClaimHint.Text = "⏰ Code expired. Click \"Get my code\" again.";
                    }
                };
            }
            _claimPollTimer.Start();
        }

        private async void BtnDcbPull_Click(object sender, RoutedEventArgs e)
        {
            StashDiscordFromUi();
            TxtDcbStatus.Text = "Pulling...";
            var (ok, n, msg) = await DiscordSync.Instance.PullAsync();
            TxtDcbStatus.Text = (ok ? "✓ " : "✗ ") + msg;
        }
        private async void BtnDcbPush_Click(object sender, RoutedEventArgs e)
        {
            StashDiscordFromUi();
            TxtDcbStatus.Text = "Pushing...";
            var (ok, n, msg) = await DiscordSync.Instance.PushAsync();
            TxtDcbStatus.Text = (ok ? "✓ " : "✗ ") + msg;
        }
        private async void BtnDcbUnlink_Click(object sender, RoutedEventArgs e)
        {
            var ok = MessageBox.Show(this,
                "Unlink this server from your Loadout install? Wallet data on the worker will be cleared. Discord-side balances will reset.",
                "Unlink Discord server", MessageBoxButton.OKCancel, MessageBoxImage.Warning);
            if (ok != MessageBoxResult.OK) return;
            TxtDcbStatus.Text = "Unlinking...";
            var (success, msg) = await DiscordSync.Instance.UnlinkAsync();
            TxtDcbStatus.Text = (success ? "✓ " : "✗ ") + msg;
            BindDiscordBotTab();
        }

        // ── Wallets + shop ───────────────────────────────────────────────────

        // Lightweight VM for the wallets DataGrid - flattens BoltsAccount
        // into platform/handle/balance/timestamps so the grid binds cleanly.
        public sealed class WalletRow
        {
            public string Platform { get; set; }
            public string Display  { get; set; }
            public string Key      { get; set; }
            public long   Balance  { get; set; }
            public long   LifetimeEarned { get; set; }
            public int    StreakDays { get; set; }
            public DateTime LastActivityUtc { get; set; }
            public string LastActivityDisplay =>
                LastActivityUtc.Ticks == 0 ? "(never)" : LastActivityUtc.ToLocalTime().ToString("g");
        }

        private void BindWalletsAndShop()
        {
            var s = SettingsManager.Instance.Current;
            // Shop
            ChkShopEnabled.IsChecked = s.BoltsShop.Enabled;
            TxtShopCmd.Text          = s.BoltsShop.ShopCommand ?? "!shop";
            TxtBuyCmd.Text           = s.BoltsShop.BuyCommand  ?? "!buy";
            _shopItems.Clear();
            if (s.BoltsShop.Items != null)
                foreach (var it in s.BoltsShop.Items) _shopItems.Add(it);
            GrdShop.ItemsSource = _shopItems;

            // Wallets - load on-demand; the grid is empty until the user clicks Refresh
            // (or the constructor flips through here for the initial pass).
            GrdWallets.ItemsSource = _wallets;
            ReloadWallets();
        }

        private void ReloadWallets()
        {
            _wallets.Clear();
            try
            {
                BoltsWallet.Instance.Initialize();
                foreach (var a in BoltsWallet.Instance.AllAccounts())
                {
                    BoltsWallet.SplitKey(a.Key, out var p, out var h);
                    _wallets.Add(new WalletRow
                    {
                        Platform = p ?? "?",
                        Display  = a.Display ?? h ?? a.Key,
                        Key      = a.Key,
                        Balance  = a.Balance,
                        LifetimeEarned = a.LifetimeEarned,
                        StreakDays = a.StreakDays,
                        LastActivityUtc = a.LastActivityUtc
                    });
                }
            }
            catch (Exception ex) { Util.ErrorLog.Write("ReloadWallets", ex); }
        }

        private void BtnWalletsRefresh_Click(object sender, RoutedEventArgs e) => ReloadWallets();

        private void BtnWalletApply_Click(object sender, RoutedEventArgs e)
        {
            if (!(GrdWallets.SelectedItem is WalletRow w))
            {
                TxtWalletHint.Text = "Pick a wallet first.";
                return;
            }
            if (!long.TryParse((TxtWalletDelta.Text ?? "0").Trim(), out var delta) || delta == 0)
            {
                TxtWalletHint.Text = "Enter a non-zero integer (use - for debit).";
                return;
            }
            BoltsWallet.SplitKey(w.Key, out var platform, out var handle);
            try
            {
                if (delta > 0)
                    BoltsWallet.Instance.Earn(platform, handle, delta, "manual:" + ((TxtWalletReason.Text ?? "ui").Trim()));
                else
                    BoltsWallet.Instance.Spend(platform, handle, -delta, "manual:" + ((TxtWalletReason.Text ?? "ui").Trim()));
                TxtWalletHint.Text = "Applied " + (delta > 0 ? "+" : "") + delta + " to " + w.Display + ".";
                TxtWalletDelta.Text = "";
                ReloadWallets();
            }
            catch (Exception ex)
            {
                TxtWalletHint.Text = "Failed: " + ex.Message;
            }
        }

        private void BtnWalletZero_Click(object sender, RoutedEventArgs e)
        {
            if (!(GrdWallets.SelectedItem is WalletRow w)) { TxtWalletHint.Text = "Pick a wallet first."; return; }
            if (w.Balance == 0) { TxtWalletHint.Text = "Already zero."; return; }
            BoltsWallet.SplitKey(w.Key, out var platform, out var handle);
            BoltsWallet.Instance.Spend(platform, handle, w.Balance, "manual:zero");
            TxtWalletHint.Text = "Zeroed " + w.Display + ".";
            ReloadWallets();
        }

        private void BtnShopAdd_Click(object sender, RoutedEventArgs e)
        {
            _shopItems.Add(new BoltsShopItem { Name = "newitem", Cost = 100, Action = "chat:Thanks {user} for buying {item}!", Enabled = true });
            GrdShop.SelectedItem = _shopItems[_shopItems.Count - 1];
        }
        private void BtnShopRemove_Click(object sender, RoutedEventArgs e)
        {
            if (GrdShop.SelectedItem is BoltsShopItem it && ConfirmRemove("Bolts shop item")) _shopItems.Remove(it);
        }
        private void BtnShopResetStock_Click(object sender, RoutedEventArgs e)
        {
            foreach (var it in _shopItems) it.StockSold = 0;
            GrdShop.Items.Refresh();
        }

        // ── Tuning tab ───────────────────────────────────────────────────────

        private void BindTuningTab()
        {
            var s = SettingsManager.Instance.Current;

            // Hype train
            TxtHypeLevelThr.Text   = s.HypeTrain.LevelThreshold.ToString();
            TxtHypeMaxLevel.Text   = s.HypeTrain.MaxLevel.ToString();
            TxtHypeDecay.Text      = s.HypeTrain.DecayPerMinute.ToString();
            TxtHypeBoltsBase.Text  = s.HypeTrain.BoltsRewardBase.ToString();
            TxtHypeLevelUpTemplate.Text = s.HypeTrain.LevelUpTemplate ?? "";
            TxtHypeEndTemplate.Text     = s.HypeTrain.EndTemplate ?? "";
            ChkHypeAnnounceLvl.IsChecked = s.HypeTrain.AnnounceLevelUps;
            ChkHypeAnnounceEnd.IsChecked = s.HypeTrain.AnnounceEnd;

            // Ad break
            TxtAdPreWarn.Text       = s.AdBreak.PreWarnSeconds.ToString();
            TxtAdPreTemplate.Text   = s.AdBreak.PreWarnTemplate ?? "";
            TxtAdPostTemplate.Text  = s.AdBreak.PostTemplate ?? "";
            ChkAdPostThanks.IsChecked  = s.AdBreak.PostBackThanks;
            ChkAdPauseTimers.IsChecked = s.AdBreak.PauseTimedMessages;

            // Chat velocity
            TxtVelWindow.Text       = s.ChatVelocity.WindowSeconds.ToString();
            TxtVelHypeThr.Text      = s.ChatVelocity.HypeThreshold.ToString();
            TxtVelSuperThr.Text     = s.ChatVelocity.SuperHypeThreshold.ToString();
            ChkVelAutoClip.IsChecked  = s.ChatVelocity.AutoClipOnSuperHype;
            ChkVelAnnounce.IsChecked  = s.ChatVelocity.AnnounceHype;
            TxtVelHypeTemplate.Text   = s.ChatVelocity.HypeTemplate ?? "";

            // Auto poll
            TxtAutoPollIdle.Text    = s.AutoPoll.IdleMinutesToTrigger.ToString();
            TxtAutoPollWindow.Text  = s.AutoPoll.VoteWindowSeconds.ToString();
            TxtAutoPollPool.Text    = string.Join(Environment.NewLine, s.AutoPoll.QuestionPool ?? new List<string>());
            ChkAutoPollAnnounce.IsChecked = s.AutoPoll.AnnounceResults;

            // Sub anniversary
            TxtAnnivMilestones.Text = string.Join(",", s.SubAnniversary.Milestones ?? new List<int>());
            TxtAnnivTemplate.Text   = s.SubAnniversary.Template ?? "";
            ChkAnnivAnnounce.IsChecked = s.SubAnniversary.AnnounceInChat;
            TxtAnnivWebhook.Text    = s.SubAnniversary.DiscordWebhook ?? "";

            // Sub raid train
            TxtSrtWindow.Text       = s.SubRaidTrain.WindowSeconds.ToString();
            TxtSrtMin.Text          = s.SubRaidTrain.MinSubsToTrigger.ToString();
            TxtSrtAnnounceAt.Text   = string.Join(",", s.SubRaidTrain.AnnounceAt ?? new List<int>());
            TxtSrtTemplate.Text     = s.SubRaidTrain.Template ?? "";

            // CC coin
            ChkCcAnnounce.IsChecked  = s.CcCoin.AnnounceCoinEarn;
            TxtCcTemplate.Text       = s.CcCoin.EarnTemplate ?? "";
            ChkCcAwardBolts.IsChecked = s.CcCoin.AwardBolts;

            // First words
            ChkFwResetOnOnline.IsChecked = s.FirstWords.ResetOnStreamOnline;
            ChkFwAnnounce.IsChecked      = s.FirstWords.AnnounceFirstChatter;
            TxtFwTemplate.Text           = s.FirstWords.Template ?? "";
        }

        private void SaveTuningTab(LoadoutSettings s)
        {
            int iv;
            // Hype train
            if (int.TryParse(TxtHypeLevelThr.Text,  out iv) && iv >= 1) s.HypeTrain.LevelThreshold  = iv;
            if (int.TryParse(TxtHypeMaxLevel.Text,  out iv) && iv >= 1) s.HypeTrain.MaxLevel        = iv;
            if (int.TryParse(TxtHypeDecay.Text,     out iv) && iv >= 0) s.HypeTrain.DecayPerMinute  = iv;
            if (int.TryParse(TxtHypeBoltsBase.Text, out iv) && iv >= 0) s.HypeTrain.BoltsRewardBase = iv;
            s.HypeTrain.LevelUpTemplate = TxtHypeLevelUpTemplate.Text ?? s.HypeTrain.LevelUpTemplate;
            s.HypeTrain.EndTemplate     = TxtHypeEndTemplate.Text     ?? s.HypeTrain.EndTemplate;
            s.HypeTrain.AnnounceLevelUps = ChkHypeAnnounceLvl.IsChecked == true;
            s.HypeTrain.AnnounceEnd      = ChkHypeAnnounceEnd.IsChecked == true;

            // Ad break
            if (int.TryParse(TxtAdPreWarn.Text, out iv) && iv >= 0) s.AdBreak.PreWarnSeconds = iv;
            s.AdBreak.PreWarnTemplate = TxtAdPreTemplate.Text  ?? s.AdBreak.PreWarnTemplate;
            s.AdBreak.PostTemplate    = TxtAdPostTemplate.Text ?? s.AdBreak.PostTemplate;
            s.AdBreak.PostBackThanks      = ChkAdPostThanks.IsChecked == true;
            s.AdBreak.PauseTimedMessages  = ChkAdPauseTimers.IsChecked == true;

            // Chat velocity
            if (int.TryParse(TxtVelWindow.Text,   out iv) && iv >= 5) s.ChatVelocity.WindowSeconds       = iv;
            if (int.TryParse(TxtVelHypeThr.Text,  out iv) && iv >= 1) s.ChatVelocity.HypeThreshold       = iv;
            if (int.TryParse(TxtVelSuperThr.Text, out iv) && iv >= 1) s.ChatVelocity.SuperHypeThreshold  = iv;
            s.ChatVelocity.AutoClipOnSuperHype = ChkVelAutoClip.IsChecked == true;
            s.ChatVelocity.AnnounceHype        = ChkVelAnnounce.IsChecked == true;
            s.ChatVelocity.HypeTemplate        = TxtVelHypeTemplate.Text ?? s.ChatVelocity.HypeTemplate;

            // Auto poll
            if (int.TryParse(TxtAutoPollIdle.Text,   out iv) && iv >= 1) s.AutoPoll.IdleMinutesToTrigger = iv;
            if (int.TryParse(TxtAutoPollWindow.Text, out iv) && iv >= 5) s.AutoPoll.VoteWindowSeconds    = iv;
            s.AutoPoll.QuestionPool = (TxtAutoPollPool.Text ?? "")
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
            s.AutoPoll.AnnounceResults = ChkAutoPollAnnounce.IsChecked == true;

            // Sub anniversary
            s.SubAnniversary.Milestones = ParseIntCsv(TxtAnnivMilestones.Text);
            s.SubAnniversary.Template = TxtAnnivTemplate.Text ?? s.SubAnniversary.Template;
            s.SubAnniversary.AnnounceInChat = ChkAnnivAnnounce.IsChecked == true;
            s.SubAnniversary.DiscordWebhook = (TxtAnnivWebhook.Text ?? "").Trim();

            // Sub raid train
            if (int.TryParse(TxtSrtWindow.Text, out iv) && iv >= 30) s.SubRaidTrain.WindowSeconds    = iv;
            if (int.TryParse(TxtSrtMin.Text,    out iv) && iv >= 2)  s.SubRaidTrain.MinSubsToTrigger = iv;
            s.SubRaidTrain.AnnounceAt = ParseIntCsv(TxtSrtAnnounceAt.Text);
            s.SubRaidTrain.Template   = TxtSrtTemplate.Text ?? s.SubRaidTrain.Template;

            // CC coin
            s.CcCoin.AnnounceCoinEarn = ChkCcAnnounce.IsChecked == true;
            s.CcCoin.EarnTemplate     = TxtCcTemplate.Text ?? s.CcCoin.EarnTemplate;
            s.CcCoin.AwardBolts       = ChkCcAwardBolts.IsChecked == true;

            // First words
            s.FirstWords.ResetOnStreamOnline  = ChkFwResetOnOnline.IsChecked == true;
            s.FirstWords.AnnounceFirstChatter = ChkFwAnnounce.IsChecked == true;
            s.FirstWords.Template             = TxtFwTemplate.Text ?? s.FirstWords.Template;
        }

        private static List<int> ParseIntCsv(string raw) =>
            (raw ?? "").Split(',')
                .Select(x => x.Trim())
                .Where(x => int.TryParse(x, out _))
                .Select(int.Parse).ToList();

        // ── Test alert ───────────────────────────────────────────────────────

        // Fires a synthetic event of the row's Kind through the dispatcher so
        // AlertsModule renders it like a real one - chat post (gated) + bus
        // event for overlays. Sample args are filled in from common SB-style
        // shapes; the streamer can sanity-check templates against {user},
        // {tier}, {bits}, {viewers}, etc.
        private void BtnAlertTest_Click(object sender, RoutedEventArgs e)
        {
            var kind = (sender as Button)?.Tag?.ToString();
            if (string.IsNullOrEmpty(kind)) return;
            var s = SettingsManager.Instance.Current;
            var args = new Dictionary<string, object>
            {
                ["user"]        = s.BroadcasterName ?? "test_user",
                ["userName"]    = s.BroadcasterName ?? "test_user",
                ["userType"]    = "viewer",
                ["eventSource"] = "twitch",
                ["tier"]        = "1",
                ["months"]      = 6,
                ["count"]       = 3,
                ["gifter"]      = (s.BroadcasterName ?? "test_user") + "_friend",
                ["bits"]        = 500,
                ["viewers"]     = 42,
                ["amount"]      = "$5.00",
                ["gift"]        = "Rose",
                ["coins"]       = 1,
            };
            try
            {
                // 1. Dispatch through the normal event path so AlertsModule
                //    handles chat send (gated by ChatNoise.AlertsToChat).
                SbEventDispatcher.Instance.DispatchEvent(kind, args);

                // 2. Also publish to the Aquilo Bus so any open OBS overlay
                //    browser source renders the alert — lets the streamer
                //    place / re-position the source without firing a real
                //    event.
                AquiloBus.Instance.Publish("alerts.fired", new
                {
                    kind   = kind,
                    args   = args,
                    source = "test",
                    ts     = DateTime.UtcNow
                });

                ShowSavedHint("Fired test " + kind + " (chat + overlay).");
            }
            catch (Exception ex)
            {
                ShowSavedHint("Test failed: " + ex.Message);
            }
        }

        // ── Test welcome ────────────────────────────────────────────────────
        // Synthesizes a chat event with the appropriate userType so
        // WelcomesModule picks the right template, AND publishes to the
        // Aquilo Bus so any chat-overlay browser source renders the
        // welcome (lets the streamer adjust placement live).
        private void BtnWelcomeTest_Click(object sender, RoutedEventArgs e)
        {
            var kind = (sender as Button)?.Tag?.ToString();
            if (string.IsNullOrEmpty(kind)) return;
            var s = SettingsManager.Instance.Current;
            var sampleUser = (s.BroadcasterName ?? "test_viewer") + "_friend";

            string template;
            switch (kind)
            {
                case "first":     template = s.Welcomes.FirstTime; break;
                case "returning": template = s.Welcomes.Returning; break;
                case "regular":   template = s.Welcomes.Regular;   break;
                case "sub":       template = s.Welcomes.Sub;       break;
                case "vip":       template = s.Welcomes.Vip;       break;
                case "mod":       template = s.Welcomes.Mod;       break;
                default:          template = s.Welcomes.FirstTime; break;
            }

            try
            {
                AquiloBus.Instance.Publish("welcome.fired", new
                {
                    user     = sampleUser,
                    userType = kind,
                    platform = "twitch",
                    template = template,
                    rendered = (template ?? "").Replace("{user}", sampleUser),
                    source   = "test",
                    ts       = DateTime.UtcNow
                });
                Util.EventStats.Instance.Increment("welcome.test." + kind);
                ShowSavedHint("Fired test welcome (" + kind + ") to overlay.");
            }
            catch (Exception ex)
            {
                ShowSavedHint("Test failed: " + ex.Message);
            }
        }
    }
}
