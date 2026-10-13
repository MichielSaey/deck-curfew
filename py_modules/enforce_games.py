"""Kill running Steam game process trees (PauseGames-style)."""

from __future__ import annotations

import logging
import os
import re
import subprocess
from typing import Optional

logger = logging.getLogger("deck-curfew")

REAPER_RE = re.compile(r"AppId=(\d+)", re.IGNORECASE)


def get_all_children(pid: int) -> list[str]:
    pids: list[str] = []
    tmp = [str(pid)]
    try:
        while tmp:
            ppid = tmp.pop(0)
            with subprocess.Popen(
                ["ps", "--ppid", ppid, "-o", "pid="],
                stdout=subprocess.PIPE,
            ) as proc:
                lines = proc.stdout.readlines() if proc.stdout else []
            for raw in lines:
                child = raw.strip().decode() if isinstance(raw, bytes) else str(raw).strip()
                if not child:
                    continue
                pids.append(child)
                tmp.append(child)
    except Exception:
        return pids
    return pids


def find_reaper_pids() -> list[tuple[int, Optional[str]]]:
    """Return (pid, appid) for Steam reaper game hosts."""
    found: list[tuple[int, Optional[str]]] = []
    try:
        # Match steam's reaper launcher that carries AppId=
        out = subprocess.check_output(
            ["pgrep", "-af", r"/reaper(\s|$).*AppId="],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        return found
    except FileNotFoundError:
        return found

    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if not parts or not parts[0].isdigit():
            continue
        pid = int(parts[0])
        cmd = parts[1] if len(parts) > 1 else ""
        match = REAPER_RE.search(cmd)
        appid = match.group(1) if match else None
        found.append((pid, appid))
    return found


def signal_tree(pid: int, sig: str = "SIGTERM") -> bool:
    children = get_all_children(pid)
    targets = children + [str(pid)]
    if not targets:
        return False
    cmd = ["kill", f"-{sig}", *targets]
    try:
        return subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    except Exception:
        return False


def kill_running_steam_games() -> list[dict]:
    """
    Terminate running Steam game sessions.
    Returns list of {pid, appid, ok} for logging.
    """
    results: list[dict] = []
    for pid, appid in find_reaper_pids():
        # Never touch pid 1 / ourselves
        if pid <= 1 or pid == os.getpid():
            continue
        ok = signal_tree(pid, "SIGTERM")
        results.append({"pid": pid, "appid": appid, "ok": ok})
        logger.info("curfew terminate pid=%s appid=%s ok=%s", pid, appid, ok)
    return results
