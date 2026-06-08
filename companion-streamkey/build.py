"""Build the single-file Windows exe with PyInstaller.

  python build.py

Produces dist/AquiloStreamkey.exe. The release workflow runs this on a
windows runner. Windowed (no console) so the tray app launches clean.
"""
import subprocess
import sys

NAME = "AquiloStreamkey"
ENTRY = "streamkey_app.py"


def main():
    args = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--onefile", "--windowed",
        "--name", NAME,
        "--icon", "assets/key.ico",
        # Extract under %LOCALAPPDATA% so the bootloader never has to write
        # into a launch-context CWD it might not own. Earlier we used "."
        # but that resolves to whatever CWD the bootloader inherits, which
        # for launches from HKCU\Run, a pinned .lnk without WorkingDirectory,
        # or the Task Scheduler watchdog is C:\WINDOWS\system32 -- not
        # writable for normal users, so PyInstaller dies with
        # "Could not create temporary directory!". PyInstaller's bootloader
        # expands env-var refs in this string via ExpandEnvironmentStringsW
        # on Windows. %LOCALAPPDATA% also sidesteps the original %TEMP%
        # bug (some setups silently block DLL writes under user TEMP),
        # so this one path is robust against both failure modes.
        "--runtime-tmpdir", r"%LOCALAPPDATA%\AquiloStreamkey\runtime",
        # Bundle the tray icon; tray.py resolves it via sys._MEIPASS.
        "--add-data", "assets/tray-64.png;assets",
        # Bundle the .ico too — shortcut.py reads it when writing the
        # Desktop/Start-menu .lnk so the pinned taskbar icon is the
        # aurora key mark, not the generic python window.
        "--add-data", "assets/key.ico;assets",
        # pystray's Windows backend + PIL plugins are pulled in dynamically.
        "--hidden-import", "pystray._win32",
        "--hidden-import", "PIL._tkinter_finder",
        "--collect-submodules", "pystray",
        ENTRY,
    ]
    print("Running:", " ".join(args))
    raise SystemExit(subprocess.call(args))


if __name__ == "__main__":
    main()
