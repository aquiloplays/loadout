using System;
using System.Windows;
using System.Windows.Controls;
using Loadout.Patreon;
using Loadout.Settings;

namespace Loadout.UI
{
    public partial class OnboardingWindow : Window
    {
        private const int TotalSteps = 8;
        private int _currentStep = 1;

        public OnboardingWindow()
        {
            InitializeComponent();
            LoadFromSettings();
            UpdateView();
        }

        private void LoadFromSettings()
        {
            var s = SettingsManager.Instance.Current;

            ChkTwitch.IsChecked  = s.Platforms.Twitch;
            ChkTikTok.IsChecked  = s.Platforms.TikTok;
            ChkYouTube.IsChecked = s.Platforms.YouTube;
            ChkKick.IsChecked    = s.Platforms.Kick;
            TxtBroadcaster.Text  = s.BroadcasterName ?? "";

            ChkInfo.IsChecked       = s.Modules.InfoCommands;
            ChkWelcomes.IsChecked   = s.Modules.ContextWelcomes;
            ChkLoyalty.IsChecked    = s.Modules.Bolts;
            ChkAlerts.IsChecked     = s.Modules.Alerts;
            ChkTimers.IsChecked     = s.Modules.TimedMessages;
            ChkAi.IsChecked         = s.Modules.AiShoutouts;
            ChkHype.IsChecked       = s.Modules.TikTokHypeTrain;
            ChkRecap.IsChecked      = s.Modules.StreamRecap;
            ChkDiscord.IsChecked    = s.Modules.DiscordLiveStatus;
            ChkWebhook.IsChecked    = s.Modules.WebhookInbox;
            ChkMod.IsChecked        = s.Modules.HateRaidDetector;
            ChkFun.IsChecked        = s.Modules.Counters;
            ChkGoals.IsChecked      = s.Modules.Goals;
            ChkCheckIn.IsChecked    = s.Modules.DailyCheckIn;
            ChkFirstWords.IsChecked = s.Modules.FirstWords;
            ChkAdBreak.IsChecked    = s.Modules.AdBreak;
            ChkSubRaid.IsChecked    = s.Modules.SubRaidTrain;
            ChkSubAnniv.IsChecked   = s.Modules.SubAnniversary;
            ChkCcCoins.IsChecked    = s.Modules.CcCoinTracker;
            ChkVip.IsChecked        = s.Modules.VipRotation;
            ChkAutoPoll.IsChecked   = s.Modules.AutoPoll;
            ChkApex.IsChecked       = s.Modules.Apex;

            TxtDiscordWebhook.Text  = s.Discord.LiveStatusWebhook ?? "";
            TxtDiscordTemplate.Text = s.Discord.GoLiveTemplate ?? "";

            TxtAiKey.Text = s.Ai.ApiKey ?? "";
            switch ((s.Ai.Provider ?? "anthropic").ToLowerInvariant())
            {
                case "openai": CmbAiProvider.SelectedIndex = 1; break;
                case "none":   CmbAiProvider.SelectedIndex = 2; break;
                default:       CmbAiProvider.SelectedIndex = 0; break;
            }

            TxtWebhookPort.Text   = s.Webhooks.Port.ToString();
            TxtWebhookSecret.Text = s.Webhooks.SharedSecret ?? "";
        }

        private void SaveStep(int step)
        {
            SettingsManager.Instance.Mutate(s =>
            {
                if (step == 2)
                {
                    s.Platforms.Twitch  = ChkTwitch.IsChecked  == true;
                    s.Platforms.TikTok  = ChkTikTok.IsChecked  == true;
                    s.Platforms.YouTube = ChkYouTube.IsChecked == true;
                    s.Platforms.Kick    = ChkKick.IsChecked    == true;
                    s.BroadcasterName   = (TxtBroadcaster.Text ?? "").Trim();
                }
                else if (step == 3)
                {
                    s.Modules.InfoCommands     = ChkInfo.IsChecked == true;
                    s.Modules.ContextWelcomes  = ChkWelcomes.IsChecked == true;
                    s.Modules.Bolts            = ChkLoyalty.IsChecked == true;
                    s.Modules.Alerts           = ChkAlerts.IsChecked == true;
                    s.Modules.TimedMessages    = ChkTimers.IsChecked == true;
                    s.Modules.AiShoutouts      = ChkAi.IsChecked == true;
                    s.Modules.TikTokHypeTrain  = ChkHype.IsChecked == true;
                    s.Modules.StreamRecap      = ChkRecap.IsChecked == true;
                    s.Modules.DiscordLiveStatus = ChkDiscord.IsChecked == true;
                    s.Modules.WebhookInbox     = ChkWebhook.IsChecked == true;
                    s.Modules.HateRaidDetector = ChkMod.IsChecked == true;
                    s.Modules.Counters         = ChkFun.IsChecked == true;
                    s.Modules.Goals            = ChkGoals.IsChecked == true;
                    s.Modules.DailyCheckIn     = ChkCheckIn.IsChecked == true;
                    s.Modules.FirstWords       = ChkFirstWords.IsChecked == true;
                    s.Modules.AdBreak          = ChkAdBreak.IsChecked == true;
                    s.Modules.SubRaidTrain     = ChkSubRaid.IsChecked == true;
                    s.Modules.SubAnniversary   = ChkSubAnniv.IsChecked == true;
                    s.Modules.CcCoinTracker    = ChkCcCoins.IsChecked == true;
                    s.Modules.VipRotation      = ChkVip.IsChecked == true;
                    s.Modules.AutoPoll         = ChkAutoPoll.IsChecked == true;
                    s.Modules.Apex             = ChkApex.IsChecked == true;
                }
                else if (step == 4)
                {
                    s.Discord.LiveStatusWebhook = (TxtDiscordWebhook.Text ?? "").Trim();
                    s.Discord.GoLiveTemplate    = TxtDiscordTemplate.Text ?? s.Discord.GoLiveTemplate;
                }
                else if (step == 5)
                {
                    s.Ai.Provider = ((ComboBoxItem)CmbAiProvider.SelectedItem)?.Tag?.ToString() ?? "anthropic";
                    s.Ai.ApiKey   = (TxtAiKey.Text ?? "").Trim();
                }
                else if (step == 6)
                {
                    if (int.TryParse(TxtWebhookPort.Text, out var port) && port > 0 && port < 65536)
                        s.Webhooks.Port = port;
                    s.Webhooks.SharedSecret = (TxtWebhookSecret.Text ?? "").Trim();
                }
            });
        }

        private void UpdateView()
        {
            var stepNames = new[] { "Welcome", "Platforms", "Modules", "Discord", "AI shoutouts", "Webhook inbox", "Patreon", "Done" };
            StepLabel.Text = "Step " + _currentStep + " of " + TotalSteps + " - " + stepNames[_currentStep - 1];

            Step1.Visibility = _currentStep == 1 ? Visibility.Visible : Visibility.Collapsed;
            Step2.Visibility = _currentStep == 2 ? Visibility.Visible : Visibility.Collapsed;
            Step3.Visibility = _currentStep == 3 ? Visibility.Visible : Visibility.Collapsed;
            Step4.Visibility = _currentStep == 4 ? Visibility.Visible : Visibility.Collapsed;
            Step5.Visibility = _currentStep == 5 ? Visibility.Visible : Visibility.Collapsed;
            Step6.Visibility = _currentStep == 6 ? Visibility.Visible : Visibility.Collapsed;
            Step7.Visibility = _currentStep == 7 ? Visibility.Visible : Visibility.Collapsed;
            Step8.Visibility = _currentStep == 8 ? Visibility.Visible : Visibility.Collapsed;

            if (_currentStep == 7) RefreshPatreonStep();

            BtnBack.IsEnabled = _currentStep > 1;
            BtnSkip.Visibility = _currentStep == TotalSteps ? Visibility.Hidden : Visibility.Visible;
            BtnNext.Content   = _currentStep == TotalSteps ? "Finish" : "Next";
        }

        private void BtnNext_Click(object sender, RoutedEventArgs e)
        {
            SaveStep(_currentStep);
            if (_currentStep < TotalSteps)
            {
                _currentStep++;
                UpdateView();
            }
            else
            {
                FinishWizard();
            }
        }

        private void BtnBack_Click(object sender, RoutedEventArgs e)
        {
            if (_currentStep > 1)
            {
                _currentStep--;
                UpdateView();
            }
        }

        private void BtnSkip_Click(object sender, RoutedEventArgs e)
        {
            FinishWizard();
        }

        private void FinishWizard()
        {
            SettingsManager.Instance.Mutate(s => s.OnboardingDone = true);
            SettingsManager.Instance.SaveNow();

            var openSettings = ChkOpenSettings.IsChecked == true && _currentStep == TotalSteps;
            Close();

            if (openSettings)
            {
                var win = SettingsWindow.GetOrCreate();
                win.Show();
                win.Activate();
            }
        }

        private void RefreshPatreonStep()
        {
            var s = PatreonClient.Instance.Current;
            if (s.SignedIn && s.Entitled)
                TxtPatreonStatus.Text = "Connected: " + Entitlements.CurrentTierDisplay() + " - all features unlocked.";
            else if (s.SignedIn)
                TxtPatreonStatus.Text = "Connected (no active tier yet). Pledge on Patreon to unlock Plus / Pro features.";
            else
                TxtPatreonStatus.Text = "Not connected. The free tier still works fully.";
        }

        private async void BtnPatreonConnect_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                BtnPatreonConnect.IsEnabled = false;
                TxtPatreonStatus.Text = "Opening browser - complete sign-in there.";
                await PatreonClient.Instance.StartSignInAsync();
            }
            catch (Exception ex)
            {
                TxtPatreonStatus.Text = "Sign-in failed: " + ex.Message;
            }
            finally
            {
                BtnPatreonConnect.IsEnabled = true;
                RefreshPatreonStep();
            }
        }

        private void BtnPatreonSkip_Click(object sender, RoutedEventArgs e)
        {
            // Move to the final step.
            _currentStep++;
            UpdateView();
        }

        // ── Module preset buttons ────────────────────────────────────────────
        // These set the visible checkboxes only; the user can still tweak
        // before clicking Next. Recommended is the "what most streamers want"
        // baseline; Enable-all and Disable-all are escape hatches.

        private System.Windows.Controls.CheckBox[] AllModuleChecks() => new[]
        {
            ChkInfo, ChkWelcomes, ChkLoyalty, ChkAlerts, ChkTimers, ChkAi,
            ChkHype, ChkRecap, ChkDiscord, ChkWebhook, ChkMod, ChkFun,
            ChkGoals, ChkCheckIn, ChkFirstWords, ChkAdBreak, ChkSubRaid,
            ChkSubAnniv, ChkCcCoins, ChkVip, ChkAutoPoll, ChkApex
        };

        private void BtnPresetAll_Click(object sender, RoutedEventArgs e)
        {
            foreach (var c in AllModuleChecks()) c.IsChecked = true;
        }

        private void BtnPresetNone_Click(object sender, RoutedEventArgs e)
        {
            foreach (var c in AllModuleChecks()) c.IsChecked = false;
        }

        private void BtnPresetRecommended_Click(object sender, RoutedEventArgs e)
        {
            // Sensible "I want a working channel today" baseline. Anything
            // that needs upfront config (AI key, webhooks, AutoPoll, VIP,
            // Daily Check-In reward setup) stays off.
            foreach (var c in AllModuleChecks()) c.IsChecked = false;
            ChkInfo.IsChecked       = true;
            ChkWelcomes.IsChecked   = true;
            ChkAlerts.IsChecked     = true;
            ChkLoyalty.IsChecked    = true;     // Bolts wallet
            ChkRecap.IsChecked      = true;
            ChkFun.IsChecked        = true;     // Counters
            ChkFirstWords.IsChecked = true;
            ChkAdBreak.IsChecked    = true;
            ChkSubRaid.IsChecked    = true;
            ChkSubAnniv.IsChecked   = true;
        }
    }
}
