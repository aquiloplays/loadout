"""Start-with-Windows toggle via the HKCU Run registry key.

Enabling Start-with-Windows also installs a Task Scheduler watchdog that
relaunches the companion every two minutes if it has died (see
[[watchdog_task]]). They share the single tray toggle by design.

No-ops cleanly off Windows (winreg import guarded) so the module imports in
CI / on dev machines without raising.
"""
import os
import sys

import watchdog_task

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE_NAME = "AquiloStreamkey"

try:
    import winreg  # type: ignore
except ImportError:  # non-Windows
    winreg = None


def _command():
    # When frozen by PyInstaller, sys.executable IS the companion exe.
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    return f'"{sys.executable}" "{os.path.abspath(sys.argv[0])}"'


def is_enabled():
    if winreg is None:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            val, _ = winreg.QueryValueEx(k, VALUE_NAME)
            return bool(val)
    except OSError:
        return False


def enable():
    if winreg is None:
        return False
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.SetValueEx(k, VALUE_NAME, 0, winreg.REG_SZ, _command())
        watchdog_task.enable()
        return True
    except OSError:
        return False


def disable():
    if winreg is None:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, VALUE_NAME)
        watchdog_task.disable()
        return True
    except OSError:
        return False
