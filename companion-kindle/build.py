"""Build the single-file Windows exe with PyInstaller.

  python build.py

Produces dist/AquiloKindle.exe (windowed, no console). selenium is collected
in full so Selenium Manager's driver-resolver binary ships inside the exe.
"""
import subprocess
import sys

NAME = "AquiloKindle"
ENTRY = "kindle_app.py"


def main():
    args = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--onefile", "--windowed",
        "--name", NAME,
        "--icon", "assets/key.ico",
        # Extract under %LOCALAPPDATA% so the bootloader never writes into a
        # launch-context CWD it may not own (HKCU\\Run launches from system32).
        "--runtime-tmpdir", r"%LOCALAPPDATA%\AquiloKindle\runtime",
        "--add-data", "assets/tray-64.png;assets",
        "--add-data", "assets/key.ico;assets",
        # pystray + PIL dynamic backends.
        "--hidden-import", "pystray._win32",
        "--hidden-import", "PIL._tkinter_finder",
        "--collect-submodules", "pystray",
        # selenium ships a manager binary + data the resolver needs at runtime.
        "--collect-all", "selenium",
        ENTRY,
    ]
    print("Running:", " ".join(args))
    raise SystemExit(subprocess.call(args))


if __name__ == "__main__":
    main()
