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
        # Extract next to the exe instead of %TEMP%. Some Windows setups
        # (AV/policy interference) silently block writes inside the user TEMP
        # tree, so PyInstaller drops a _MEI* folder but never lands the DLLs,
        # then LoadLibrary("python311.dll") fails. Extracting beside the exe
        # avoids that path entirely.
        "--runtime-tmpdir", ".",
        # Bundle the tray icon; tray.py resolves it via sys._MEIPASS.
        "--add-data", "assets/tray-64.png;assets",
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
