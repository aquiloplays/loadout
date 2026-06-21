"""Subprocess manager for `aquilo-crowdplay`.

Spawns `node src/index.js` with the chosen GAME= env var, streams its stdout
+ stderr into a Qt signal, and parses well-known status events so the main
window can render live state without polling.

Status events we sniff out (matching strings in aquilo-crowdplay's logs):
  [ext-relay] up          -> relay channel online
  [tcp] adapter feed on   -> TCP listener bound (ready for an adapter)
  [tcp] +adapter (N)      -> an adapter just connected (N = total connected)
  [tcp] -adapter          -> adapter disconnected (synthetic; we emit from
                             "core disconnected" / EOF heuristics)
  [http] emulator pull    -> HTTP listener bound
  [FIRE] <effect> <- src  -> an effect just fired (we surface a counter)

Process lifecycle:
  start()  -> spawns node, returns immediately
  stop()   -> SIGTERM/kill the process, waits up to 3s
  is_running() -> True iff Popen handle is alive
"""

from __future__ import annotations
import os
import re
import shutil
import signal
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from PySide6.QtCore import QObject, QThread, Signal

from companion_crowdplay.win_job import (
    assign_process_to_job, close_job, create_kill_on_close_job,
    find_pid_on_port, port_in_use,
)


# ── bundle freshness check ────────────────────────────────────────────
def _maybe_sync_bundle(bundle_root: Path) -> None:
    """If a newer copy of the aquilo-crowdplay source exists on disk, sync
    src/, manifests/, and adapters/ into the bundle so the engine boots
    with the latest code.

    We probe a list of likely source paths next to the bundle. Anything
    newer than the bundled `package.json` (used as the freshness anchor)
    wins. Misses are silent."""
    import shutil
    anchor = bundle_root / "package.json"
    if not anchor.exists():
        return
    bundle_mtime = anchor.stat().st_mtime

    here = Path(__file__).resolve()
    candidates = [
        here.parent.parent.parent.parent / "aquilo-crowdplay",
        Path.home() / "Desktop" / "Aquilo" / "aquilo-crowdplay",
        Path("C:/Users/bishe/Desktop/Aquilo/aquilo-crowdplay"),
    ]
    src_root: Optional[Path] = None
    for c in candidates:
        try:
            if c.exists() and (c / "src" / "index.js").exists() and \
               c.resolve() != bundle_root.resolve():
                src_pj = c / "package.json"
                if src_pj.exists() and src_pj.stat().st_mtime > bundle_mtime:
                    src_root = c; break
        except OSError:
            continue
    if not src_root:
        return

    print(f"[engine] syncing newer source from {src_root} into bundle")
    for sub in ("src", "manifests", "adapters"):
        src_dir = src_root / sub
        dst_dir = bundle_root / sub
        if not src_dir.exists():
            continue
        if dst_dir.exists():
            shutil.rmtree(dst_dir, ignore_errors=True)
        shutil.copytree(src_dir, dst_dir)
    pj = src_root / "package.json"
    if pj.exists():
        shutil.copy2(pj, bundle_root / "package.json")
    print(f"[engine] bundle synced; package.json mtime now matches source")


# ── status events ──────────────────────────────────────────────────────
@dataclass
class EngineStatus:
    relay_up: bool = False
    tcp_listening: bool = False
    http_listening: bool = False
    adapters_connected: int = 0
    fire_count: int = 0
    last_fire: Optional[str] = None
    last_error: Optional[str] = None
    # Raw, append-only lines for the log view.
    log_lines: list[str] = field(default_factory=list)
    # Crash log: last 100 stdout lines from before the engine died, plus
    # the exit code. Surfaced in a panel when the engine restarts so the
    # user can see WHAT crashed without log-diving.
    crash_log: Optional[list[str]] = None
    crash_exit_code: Optional[int] = None
    crash_at: Optional[float] = None


# ── stdout reader thread ───────────────────────────────────────────────
class _ReaderThread(QThread):
    """Reads engine stdout (already merged with stderr) line by line and
    re-emits each line on the GUI thread via Qt signals."""
    line = Signal(str)
    eof = Signal()

    def __init__(self, proc: subprocess.Popen, parent=None):
        super().__init__(parent)
        self._proc = proc

    def run(self) -> None:
        assert self._proc.stdout is not None
        try:
            for raw in iter(self._proc.stdout.readline, ""):
                if not raw:
                    break
                self.line.emit(raw.rstrip("\r\n"))
        except (ValueError, OSError):
            pass
        self.eof.emit()


# ── engine controller ──────────────────────────────────────────────────
_RX_ADAPTER_PLUS = re.compile(r"\[tcp\] \+adapter \((\d+)\)")
_RX_FIRE = re.compile(r"\[FIRE\]\s+(\S+)")


class EngineController(QObject):
    """Lifecycle + status of one aquilo-crowdplay subprocess."""

    # Emitted whenever status changes meaningfully (the main window calls
    # render() on receipt). Emitted with the same EngineStatus instance.
    status_changed = Signal(object)

    # Emitted when the process exits (clean or crash). int = exit code (or -1
    # if we sent SIGTERM). The status object reflects the final state.
    exited = Signal(int)

    # Emitted on each new log line for the live log view.
    log = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.status = EngineStatus()
        self._proc: Optional[subprocess.Popen] = None
        self._reader: Optional[_ReaderThread] = None
        self._project_root: Optional[Path] = None
        self._game_slug: Optional[str] = None
        self._extra_env: Optional[dict[str, str]] = None
        # Job Object handle - any Node we spawn gets added so the OS kills
        # the engine when this process exits. Prevents orphans permanently.
        self._job: Optional[int] = create_kill_on_close_job()
        # Watchdog: if the engine dies unexpectedly (not via .stop()),
        # respawn it with exponential backoff. _stopped_intentionally
        # gates this so .stop() doesn't trigger a respawn loop.
        self._stopped_intentionally = True
        self._watchdog_backoff_idx = 0
        self._watchdog_backoffs = [1, 2, 5, 10, 30]  # seconds
        from PySide6.QtCore import QTimer
        self._watchdog_timer = QTimer(self)
        self._watchdog_timer.setInterval(2000)   # check every 2s
        self._watchdog_timer.timeout.connect(self._watchdog_tick)

    # ── lifecycle ─────────────────────────────────────────────────────
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self, project_root: Path, game_slug: str,
              extra_env: Optional[dict[str, str]] = None) -> tuple[bool, str]:
        """Start the engine. Returns (ok, message). Safe to call when already
        running - returns (False, 'already running')."""
        if self.is_running():
            return False, "Engine already running."
        # Prefer a bundled portable Node (installed via Setup) over the one on
        # PATH so the user doesn't need a system install.
        node = None
        try:
            from companion_crowdplay.downloads import find_bundled_node
            bundled = find_bundled_node()
            if bundled and bundled.exists():
                node = str(bundled)
        except Exception:
            node = None
        if not node:
            node = shutil.which("node")
        if not node:
            return False, "Node.js not found. Run Settings -> Install bundled Node, or install from nodejs.org."
        if not (project_root / "src" / "index.js").exists():
            return False, f"Project root invalid: src/index.js missing under {project_root}"

        # Bundle freshness check: if a NEWER aquilo-crowdplay source tree
        # exists on disk (e.g. dev edits to Loadout/../aquilo-crowdplay/),
        # auto-sync src/, manifests/, adapters/ into the installed bundle.
        # Prevents the "Companion is running stale engine code" trap that
        # bit us during reliability-stack dev.
        try:
            _maybe_sync_bundle(project_root)
        except Exception as e:
            # Non-fatal: log and continue with whatever's bundled.
            print(f"[engine] bundle freshness check failed: {e}")

        # Pre-flight: every port the engine needs must be free, otherwise
        # the Node process crashes with EADDRINUSE right after spawn. Tell
        # the user precisely which port is busy + which PID holds it.
        for port in (8787, 8788, 8789):
            if port_in_use(port):
                pid = find_pid_on_port(port)
                pid_part = f" (PID {pid})" if pid else ""
                return False, (
                    f"Port {port} is already in use{pid_part}. Stop the other "
                    f"engine first, or run the cleanup script: "
                    f"right-click cleanup.ps1 -> Run with PowerShell."
                )

        env = os.environ.copy()
        env["GAME"] = game_slug
        if extra_env:
            env.update(extra_env)
        # Force UTF-8 stdout so the Qt UI never gets cp1252 mojibake.
        env.setdefault("PYTHONIOENCODING", "utf-8")

        creationflags = 0
        if sys.platform == "win32":
            # CREATE_NO_WINDOW so the node process doesn't flash a console.
            creationflags = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]

        try:
            self._proc = subprocess.Popen(
                [node, "src/index.js"],
                cwd=str(project_root),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                encoding="utf-8",
                errors="replace",
                creationflags=creationflags,
            )
        except OSError as e:
            return False, f"Failed to spawn node: {e}"

        # Bind the Node child to our Job Object. If the companion dies for
        # any reason (clean exit, crash, kill from Task Manager), Windows
        # tears down the engine with it. No more orphan ports.
        if self._job and self._proc.pid:
            assign_process_to_job(self._job, self._proc.pid)

        # Reset status for the new run.
        self.status = EngineStatus()
        self._project_root = project_root
        self._game_slug = game_slug
        self._extra_env = dict(extra_env) if extra_env else {}
        # Mark this as a deliberate start so the watchdog respawns if the
        # engine dies; .stop() flips this off.
        self._stopped_intentionally = False
        self._watchdog_backoff_idx = 0
        self._watchdog_timer.start()

        self._reader = _ReaderThread(self._proc, self)
        self._reader.line.connect(self._on_line)
        self._reader.eof.connect(self._on_eof)
        self._reader.start()
        self.status_changed.emit(self.status)
        return True, f"Engine starting (game={game_slug})."

    def _watchdog_tick(self) -> None:
        """Called every 2s. If the engine died unexpectedly, respawn it with
        exponential backoff. Stops watching once .stop() is called."""
        if self._stopped_intentionally:
            self._watchdog_timer.stop()
            return
        if self.is_running():
            # Healthy - reset backoff so a future death starts at 1s again.
            self._watchdog_backoff_idx = 0
            return
        # Engine died but we didn't intend to stop. Wait per backoff schedule
        # so we don't flap if the engine is broken (e.g. EADDRINUSE).
        delay_idx = min(self._watchdog_backoff_idx, len(self._watchdog_backoffs) - 1)
        # 2s polling means we wait (backoff/2) more ticks before retrying.
        # Use a simple deadline approach instead: stamp a re-arm time.
        if not hasattr(self, "_watchdog_rearm_at") or self._watchdog_rearm_at is None:
            from time import time
            self._watchdog_rearm_at = time() + self._watchdog_backoffs[delay_idx]
            self.log.emit(f"[watchdog] engine died; respawn in {self._watchdog_backoffs[delay_idx]}s")
            return
        from time import time as _now
        if _now() < self._watchdog_rearm_at:
            return
        # Respawn now.
        self._watchdog_rearm_at = None
        self._watchdog_backoff_idx += 1
        if self._project_root and self._game_slug:
            self.log.emit(f"[watchdog] respawning engine ({self._game_slug})")
            ok, msg = self.start(self._project_root, self._game_slug, self._extra_env)
            self.log.emit(f"[watchdog] {msg}")

    def stop(self) -> None:
        # Tell watchdog not to respawn.
        self._stopped_intentionally = True
        self._watchdog_timer.stop()
        if not self._proc:
            return
        if self._proc.poll() is None:
            try:
                if sys.platform == "win32":
                    self._proc.terminate()
                else:
                    self._proc.send_signal(signal.SIGTERM)
                self._proc.wait(timeout=3)
            except (subprocess.TimeoutExpired, OSError):
                try:
                    self._proc.kill()
                except OSError:
                    pass

    def __del__(self):
        # Closing the job handle triggers KILL_ON_JOB_CLOSE for any
        # surviving Node children - belt + suspenders against orphans.
        try:
            if self._job:
                close_job(self._job)
        except Exception:
            pass

    # ── stdout sink ───────────────────────────────────────────────────
    def _on_line(self, line: str) -> None:
        st = self.status
        st.log_lines.append(line)
        if len(st.log_lines) > 2000:
            del st.log_lines[:1000]

        changed = False
        if "[ext-relay] up" in line:
            st.relay_up = True; changed = True
        elif "[ext-relay] disabled" in line:
            st.relay_up = False; changed = True
        if "[tcp] adapter feed on" in line:
            st.tcp_listening = True; changed = True
        elif "[http] emulator pull feed on" in line:
            st.http_listening = True; changed = True
        m = _RX_ADAPTER_PLUS.search(line)
        if m:
            st.adapters_connected = int(m.group(1)); changed = True
        if "core disconnected" in line or "adapter disconnected" in line:
            # Engine logs this from its OWN view; we treat as -1 (clamped).
            if st.adapters_connected > 0:
                st.adapters_connected -= 1; changed = True
        m = _RX_FIRE.search(line)
        if m:
            st.fire_count += 1
            st.last_fire = m.group(1)
            changed = True
        # Errors that warrant a red banner.
        low = line.lower()
        if "error" in low and "missing" in low:
            st.last_error = line
            changed = True

        self.log.emit(line)
        if changed:
            self.status_changed.emit(st)

    def _on_eof(self) -> None:
        code = -1
        if self._proc:
            try:
                code = self._proc.wait(timeout=2)
            except (subprocess.TimeoutExpired, OSError):
                pass
        # Capture last 100 log lines so the user sees what was happening
        # right before the engine died. Surfaced in the status bar +
        # Diagnostics tab so the user doesn't have to dig through files.
        if not self._stopped_intentionally and code != 0:
            from time import time
            tail = list(self.status.log_lines)[-100:]
            self.status.crash_log = tail
            self.status.crash_exit_code = code
            self.status.crash_at = time()
            # Persist to disk for post-mortem.
            try:
                import json
                from pathlib import Path
                crash_dir = Path.home() / "AppData" / "Local" / "AquiloCrowdPlay" / "crash-logs"
                crash_dir.mkdir(parents=True, exist_ok=True)
                ts = int(time())
                crash_file = crash_dir / f"engine-crash-{ts}.log"
                with crash_file.open("w", encoding="utf-8") as f:
                    f.write(f"# Engine crash captured at unix={ts}\n")
                    f.write(f"# Exit code: {code}\n")
                    f.write(f"# Game: {self._game_slug}\n")
                    f.write(f"# Last {len(tail)} stdout lines:\n\n")
                    for line in tail:
                        f.write(line + "\n")
                self.log.emit(f"[crash] engine exit={code}; tail saved to {crash_file}")
            except Exception as e:
                self.log.emit(f"[crash] engine exit={code}; failed to persist tail: {e}")
            self.status_changed.emit(self.status)
        self.exited.emit(code)
