; Inno Setup script for aquilo-crowdplay-companion.
;
; Usage:
;   1) Build the exe:  pwsh -File build.ps1
;   2) Compile this:    ISCC.exe installer.iss
;   3) Distribute:      Output/aquilo-crowdplay-companion-setup.exe
;
; The installer puts the exe under %LocalAppData%\Programs\AquiloCrowdPlay
; (no UAC prompt), creates a Start Menu shortcut, and registers an
; AppUserModelID matching the runtime SetCurrentProcessExplicitAppUserModelID
; call so the taskbar pins to the right shortcut.

#define MyAppName          "Aquilo CrowdPlay"
#define MyAppVersion       "0.1.0"
#define MyAppPublisher     "aquilo.gg"
#define MyAppURL           "https://aquilo.gg"
#define MyAppExeName       "aquilo-crowdplay-companion.exe"
#define MyAppUserModelID   "gg.aquilo.crowdplay.companion"

[Setup]
AppId={{E7C2C9C7-7E80-4B6D-A47C-AQUILO-CROWDPLAY}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\AquiloCrowdPlay
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=Output
OutputBaseFilename=aquilo-crowdplay-companion-setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=110
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupIconFile=
DisableWelcomePage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; PyInstaller --onefile output lands in dist\
Source: "dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; \
  AppUserModelID: "{#MyAppUserModelID}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; \
  AppUserModelID: "{#MyAppUserModelID}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; \
  Flags: nowait postinstall skipifsilent
