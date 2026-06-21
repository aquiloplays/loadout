"""Windows Job Object helpers.

Lets the companion bind every Node subprocess it spawns to a Job Object with
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE set. Result: when the companion process
exits (clean OR crash OR force-quit), Windows tears down every process in
the job. No more orphan engines holding port 8787.

This module is a no-op on non-Windows platforms.

References:
  https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/
  https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
"""

from __future__ import annotations
import ctypes
import socket
import sys
from ctypes import wintypes
from typing import Optional


# ── port probe (cross-platform) ────────────────────────────────────────
def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """Returns True if `port` is bound on any interface. We test 0.0.0.0
    because the engine binds INADDR_ANY for the OBS overlay (so even a
    localhost-only check would miss it)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("0.0.0.0", port))
    except OSError:
        return True
    finally:
        s.close()
    return False


def find_pid_on_port(port: int) -> Optional[int]:
    """Best-effort lookup for the PID holding `port`. Windows-only; uses
    GetExtendedTcpTable. Returns None on platforms other than Windows or if
    the port isn't bound."""
    if sys.platform != "win32":
        return None
    # MIB_TCPTABLE_OWNER_PID / GetExtendedTcpTable
    class MIB_TCPROW_OWNER_PID(ctypes.Structure):
        _fields_ = [
            ("dwState", wintypes.DWORD),
            ("dwLocalAddr", wintypes.DWORD),
            ("dwLocalPort", wintypes.DWORD),
            ("dwRemoteAddr", wintypes.DWORD),
            ("dwRemotePort", wintypes.DWORD),
            ("dwOwningPid", wintypes.DWORD),
        ]
    iphlpapi = ctypes.WinDLL("iphlpapi.dll", use_last_error=True)
    GetExtendedTcpTable = iphlpapi.GetExtendedTcpTable
    GetExtendedTcpTable.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD),
                                    wintypes.BOOL, wintypes.ULONG, wintypes.DWORD, wintypes.DWORD]
    GetExtendedTcpTable.restype = wintypes.DWORD
    AF_INET = 2
    TCP_TABLE_OWNER_PID_LISTENER = 3
    size = wintypes.DWORD(0)
    GetExtendedTcpTable(None, ctypes.byref(size), False, AF_INET,
                        TCP_TABLE_OWNER_PID_LISTENER, 0)
    buf = (ctypes.c_byte * size.value)()
    rc = GetExtendedTcpTable(buf, ctypes.byref(size), False, AF_INET,
                             TCP_TABLE_OWNER_PID_LISTENER, 0)
    if rc != 0:
        return None
    count = ctypes.cast(buf, ctypes.POINTER(wintypes.DWORD))[0]
    rows = ctypes.cast(ctypes.addressof(buf) + ctypes.sizeof(wintypes.DWORD),
                       ctypes.POINTER(MIB_TCPROW_OWNER_PID * count))[0]
    want_be = socket.htons(port) & 0xFFFF
    for row in rows:
        # dwLocalPort is stored network-byte-order in the low word.
        if (row.dwLocalPort & 0xFFFF) == want_be:
            return int(row.dwOwningPid)
    return None


# ── Job Object ─────────────────────────────────────────────────────────
if sys.platform == "win32":
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    PROCESS_TERMINATE = 0x0001
    PROCESS_SET_QUOTA = 0x0100
    PROCESS_ALL_ACCESS = 0x1F0FFF
    JobObjectExtendedLimitInformation = 9
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]


def create_kill_on_close_job() -> Optional[int]:
    """Create a Windows Job Object that kills every process in it when the
    last handle to the job closes. Returns the HANDLE (as an int) or None
    on non-Windows / on failure."""
    if sys.platform != "win32":
        return None
    h = kernel32.CreateJobObjectW(None, None)
    if not h:
        return None
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    ok = kernel32.SetInformationJobObject(
        ctypes.c_void_p(h),
        JobObjectExtendedLimitInformation,
        ctypes.byref(info),
        ctypes.sizeof(info),
    )
    if not ok:
        kernel32.CloseHandle(ctypes.c_void_p(h))
        return None
    return h


def assign_process_to_job(job_handle: int, pid: int) -> bool:
    """Add a PID to the job. Once added, the OS will kill it when the job
    handle is released (which happens when the companion exits)."""
    if sys.platform != "win32":
        return True
    # Need both QUERY + TERMINATE + SET_QUOTA on the target process.
    proc = kernel32.OpenProcess(
        PROCESS_TERMINATE | PROCESS_SET_QUOTA | 0x0400,  # PROCESS_QUERY_INFORMATION
        False, pid,
    )
    if not proc:
        return False
    try:
        ok = kernel32.AssignProcessToJobObject(
            ctypes.c_void_p(job_handle), ctypes.c_void_p(proc)
        )
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(proc))
    return bool(ok)


def close_job(job_handle: int) -> None:
    """Closing the last handle to the job triggers KILL_ON_JOB_CLOSE."""
    if sys.platform != "win32" or not job_handle:
        return
    kernel32.CloseHandle(ctypes.c_void_p(job_handle))


# ── elevated cleanup ────────────────────────────────────────────────
def free_ports_elevated(ports: tuple[int, ...] = (8787, 8788, 8789)) -> tuple[bool, str]:
    """Self-elevate and kill any process holding one of the given ports.

    Uses ShellExecuteW with the 'runas' verb to trigger a single UAC prompt,
    then runs a one-liner cmd that resolves PIDs via netstat and force-kills
    them. Returns (launched, message). Doesn't wait for completion - the
    elevated child runs detached.
    """
    if sys.platform != "win32":
        return False, "non-Windows"
    SW_HIDE = 0
    # Build a cmd that for each port, finds the listening PID and kills it.
    # `for /f` over `netstat -ano` filters by port + LISTENING + grabs the
    # last column (PID).
    parts = []
    for p in ports:
        parts.append(
            f'for /f "tokens=5" %a in (\'netstat -ano -p tcp ^| findstr ":{p} " ^| findstr "LISTENING"\') do '
            f'(echo killing port {p} PID %a & taskkill /F /PID %a)'
        )
    cmd_line = " & ".join(parts)
    # /c so cmd exits when done; no console window pop because runas hides it
    # under elevation already.
    full = f'/c {cmd_line}'
    rc = ctypes.windll.shell32.ShellExecuteW(
        None, "runas", "cmd.exe", full, None, SW_HIDE
    )
    if int(rc) <= 32:
        # ShellExecuteW returns > 32 on success; <=32 is an HINSTANCE error
        # code, typically 5 (access denied / UAC cancel) or 31 (no handler).
        return False, f"elevation refused (code {int(rc)})"
    return True, "elevated kill spawned"
