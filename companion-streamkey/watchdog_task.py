"""Task Scheduler watchdog: relaunch the companion if it dies.

Registers a single per-user task `AquiloStreamkeyWatchdog` that fires every
two minutes. The task runs a tiny VBScript (silent, no flashing console)
which:

  1. Checks whether AquiloStreamkey.exe is in the running process list.
  2. If not, starts it again.

A two-minute cadence means a crash recovers within ~120s, but if the exe is
unrecoverable (DLL load error dialog stuck on screen) the user only sees the
respawn every two minutes, not in a tight loop. They can disable it from the
tray menu ("Auto-restart on crash").

We pair the watchdog with [[autostart]]: enabling Start with Windows also
turns the watchdog on; disabling it turns the watchdog off. They share one
toggle so there is no confusing two-switch state.

No-op cleanly off Windows so CI imports do not raise.
"""
import os
import shutil
import subprocess
import sys

TASK_NAME = "AquiloStreamkeyWatchdog"
APP_DIR_NAME = "AquiloStreamkey"
INSTALLED_EXE_NAME = "AquiloStreamkey.exe"


def _local_appdata():
    return (
        os.environ.get("LOCALAPPDATA")
        or os.environ.get("APPDATA")
        or os.path.expanduser("~")
    )


def installed_exe():
    """Path the watchdog and autostart should relaunch.

    When frozen, we do NOT trust ``sys.executable`` directly: the user usually
    runs the download straight from their Downloads folder, and both the
    watchdog (a Task Scheduler entry that fires every 2 min) and the Start-with-
    Windows Run key would then bake in that volatile path. Moving, renaming, or
    deleting the download later makes the watchdog pop a "cannot find the file
    specified" dialog every two minutes.

    So we install a stable copy under ``%LOCALAPPDATA%\\AquiloStreamkey`` and
    hand back that path, refreshing it to the running version each time. If the
    copy can't be made (locked / permissions), we fall back to the live exe
    path so behaviour is never worse than before.
    """
    if not getattr(sys, "frozen", False):
        return os.path.abspath(sys.argv[0])
    live = sys.executable
    try:
        d = os.path.join(_local_appdata(), APP_DIR_NAME)
        os.makedirs(d, exist_ok=True)
        stable = os.path.join(d, INSTALLED_EXE_NAME)
        # Already running from the installed copy → nothing to copy.
        if os.path.exists(stable) and os.path.samefile(stable, live):
            return stable
        shutil.copy2(live, stable)  # refresh to the version being run now
        return stable
    except OSError:
        return live


# Back-compat alias for existing callers.
def _exe_path():
    return installed_exe()


def _vbs_path():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    d = os.path.join(base, "AquiloStreamkey")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "watchdog.vbs")


def _write_vbs(exe):
    """VBS body that respawns the exe if no AquiloStreamkey process is running."""
    # WMI Win32_Process check picks up both the bootloader and the Python
    # child, so a stuck bootloader (dialog up) is still "alive" and we
    # do not pile up extra instances. Use \n in source + text-mode write
    # so Windows translates to \r\n once (\r\n in source would become \r\r\n).
    body = (
        'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")\n'
        'Set procs = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name=\'AquiloStreamkey.exe\'")\n'
        'If procs.Count = 0 Then\n'
        '  Set sh = CreateObject("WScript.Shell")\n'
        f'  sh.Run """{exe}""", 0, False\n'
        'End If\n'
    )
    path = _vbs_path()
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    return path


def _schtasks(*args):
    """Run schtasks.exe with /F where applicable; capture output for the log."""
    cp = subprocess.run(
        ["schtasks.exe", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return cp.returncode, (cp.stdout or "") + (cp.stderr or "")


def is_enabled():
    if sys.platform != "win32":
        return False
    rc, _ = _schtasks("/Query", "/TN", TASK_NAME)
    return rc == 0


def enable():
    if sys.platform != "win32":
        return False
    exe = _exe_path()
    vbs = _write_vbs(exe)
    # /SC MINUTE /MO 2 = every 2 minutes; /RL LIMITED runs as current user
    # (no admin), /IT keeps it interactive so the spawned exe sees the user
    # desktop (tray icon, dialogs, etc.); /F overwrites any prior entry.
    cmd = f'wscript.exe "{vbs}"'
    rc, out = _schtasks(
        "/Create", "/TN", TASK_NAME, "/SC", "MINUTE", "/MO", "2",
        "/TR", cmd, "/RL", "LIMITED", "/IT", "/F",
    )
    return rc == 0


def disable():
    if sys.platform != "win32":
        return False
    rc, _ = _schtasks("/Delete", "/TN", TASK_NAME, "/F")
    return rc == 0
