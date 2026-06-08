"""Desktop / Start-menu shortcut installer for the companion.

Drops a "Aquilo TikTok Key.lnk" file pointing at the companion's own exe
(when frozen by PyInstaller) or the python script (when running from
source). The shortcut uses the bundled key.ico so the pinned taskbar
icon reads as a real "Aquilo" app rather than a generic python window.

Pin-to-taskbar: Windows 11 removed the programmatic Pin verb, so we drop
the .lnk and pop Explorer with it selected. The user gets one
right-click -> "Pin to taskbar" to finish.

Why PowerShell + a here-string: keeps the runtime deps lean (no pywin32),
relies only on `powershell.exe` which is on every Win 10/11 box, and the
COM call (WScript.Shell.CreateShortcut) is the same one every Windows
shortcut tool has used for 20 years.
"""
import os
import subprocess
import sys
import tempfile


SHORTCUT_NAME = "Aquilo TikTok Key.lnk"


def _asset(name):
    """Locate an asset both frozen (PyInstaller _MEIPASS) and from-source."""
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "assets", name)


def _target_command():
    """Return (target_exe, args, working_dir) for the .lnk.

    When frozen, sys.executable IS the companion exe — single target, no
    args. From source, point at the running python with the script path,
    so a developer testing the menu item gets a working shortcut too.
    """
    if getattr(sys, "frozen", False):
        return sys.executable, "", os.path.dirname(sys.executable)
    script = os.path.abspath(sys.argv[0] or __file__)
    return sys.executable, f'"{script}"', os.path.dirname(script)


def _desktop_path():
    """USERPROFILE\\Desktop is the common case; some OneDrive setups
    redirect Desktop. Read the live Shell Folders mapping when present."""
    try:
        # CSIDL_DESKTOPDIRECTORY via known-folders is the most reliable
        # path - falls back to USERPROFILE\Desktop on failure.
        import ctypes
        from ctypes import wintypes
        CSIDL_DESKTOPDIRECTORY = 0x10
        SHGFP_TYPE_CURRENT = 0
        buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
        ctypes.windll.shell32.SHGetFolderPathW(
            None, CSIDL_DESKTOPDIRECTORY, None, SHGFP_TYPE_CURRENT, buf)
        if buf.value:
            return buf.value
    except Exception:
        pass
    return os.path.join(os.path.expanduser("~"), "Desktop")


def _start_menu_path():
    """%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs."""
    return os.path.join(
        os.environ.get("APPDATA", os.path.expanduser("~")),
        "Microsoft", "Windows", "Start Menu", "Programs"
    )


def _write_shortcut(lnk_path, target_exe, args, working_dir, icon_path, description):
    """Drop a .lnk file via a PowerShell here-string. PowerShell uses
    WScript.Shell.CreateShortcut under the hood - same as the WSH API.
    Returns True on success.
    """
    # Escape for a single-quoted PowerShell string. Single-quote is the
    # only character we need to worry about; doubling it escapes.
    def esc(s):
        return (s or "").replace("'", "''")

    # We deliberately go through a temp .ps1 instead of -Command so paths
    # with semicolons / quotes don't trip the parser.
    script = (
        "$sh = New-Object -ComObject WScript.Shell\n"
        f"$lnk = $sh.CreateShortcut('{esc(lnk_path)}')\n"
        f"$lnk.TargetPath = '{esc(target_exe)}'\n"
        f"$lnk.Arguments  = '{esc(args)}'\n"
        f"$lnk.WorkingDirectory = '{esc(working_dir)}'\n"
        f"$lnk.IconLocation = '{esc(icon_path)},0'\n"
        f"$lnk.Description = '{esc(description)}'\n"
        "$lnk.WindowStyle = 1\n"
        "$lnk.Save()\n"
    )
    with tempfile.NamedTemporaryFile(
        suffix=".ps1", delete=False, mode="w", encoding="utf-8"
    ) as f:
        f.write(script)
        ps1 = f.name
    try:
        # ExecutionPolicy Bypass scoped to the process so we don't leave
        # a permanent loosening behind. -NoProfile avoids loading user
        # PSReadLine / aliases that could slow the call.
        result = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-File", ps1,
            ],
            capture_output=True, text=True, timeout=15,
        )
        return result.returncode == 0
    except Exception:
        return False
    finally:
        try:
            os.unlink(ps1)
        except OSError:
            pass


def install(show_explorer=True):
    """Create the desktop + Start-menu shortcut.

    Returns a dict with keys:
      ok          (bool) - any shortcut was written
      desktop     (str)  - full path of the desktop .lnk on success, "" otherwise
      start_menu  (str)  - full path of the start-menu .lnk on success
      errors      (list[str]) - human-readable problems if anything failed
    """
    errors = []
    target_exe, args, working_dir = _target_command()
    if not target_exe or not os.path.exists(target_exe):
        return {
            "ok": False, "desktop": "", "start_menu": "",
            "errors": [f"Target executable not found: {target_exe!r}"],
        }
    icon = _asset("key.ico")
    if not os.path.exists(icon):
        # Fall back to the exe's own icon; the .lnk still works, just
        # without the aurora-key glyph.
        icon = target_exe
    desktop = _desktop_path()
    start_menu = _start_menu_path()
    try:
        os.makedirs(start_menu, exist_ok=True)
    except OSError as exc:
        errors.append(f"Could not create Start menu folder: {exc}")
    desktop_lnk = os.path.join(desktop, SHORTCUT_NAME)
    start_lnk = os.path.join(start_menu, SHORTCUT_NAME)

    desc = "Aquilo TikTok Key Generator - one-click sign in + dock open."

    ok_desktop = _write_shortcut(desktop_lnk, target_exe, args, working_dir, icon, desc)
    if not ok_desktop:
        errors.append("Failed to write Desktop shortcut.")
        desktop_lnk = ""
    ok_start = _write_shortcut(start_lnk, target_exe, args, working_dir, icon, desc)
    if not ok_start:
        errors.append("Failed to write Start-menu shortcut.")
        start_lnk = ""

    # Open Explorer with the new file selected so the user is one
    # right-click -> "Pin to taskbar" away from a real dock icon.
    # Win 11 hides Pin under "Show more options" but the verb is there.
    if show_explorer and ok_desktop and desktop_lnk:
        try:
            subprocess.Popen(
                ["explorer.exe", f"/select,{desktop_lnk}"],
                shell=False
            )
        except OSError:
            pass

    return {
        "ok": ok_desktop or ok_start,
        "desktop": desktop_lnk,
        "start_menu": start_lnk,
        "errors": errors,
    }
