import asyncio
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

import decky

# Bundled helpers
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "py_modules"))
from curfew_schedule import (  # noqa: E402
    build_session,
    clear_expired_session_fields,
    is_locked,
    normalize_settings,
    parse_hhmm,
    session_phase,
    status_payload,
)
from enforce_games import kill_running_steam_games  # noqa: E402
from updater import (  # noqa: E402
    check_latest_release,
    install_from_zip_url,
    read_installed_version,
)

try:
    from settings import SettingsManager  # type: ignore
except ImportError:
    SettingsManager = None  # type: ignore

SETTINGS_KEY = "curfew"
PLUGIN_DIR = Path(__file__).resolve().parent
UPDATE_CHECK_SECONDS = 6 * 60 * 60


class _FileSettings:
    """Fallback JSON settings when SettingsManager is unavailable (local tests)."""

    def __init__(self, path: str):
        self.path = path
        self.settings: dict[str, Any] = {}

    def read(self) -> None:
        if not os.path.isfile(self.path):
            self.settings = {}
            return
        with open(self.path, "r", encoding="utf-8") as fh:
            self.settings = json.load(fh)

    def commit(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump(self.settings, fh, indent=2)

    def getSetting(self, key: str, default=None):
        return self.settings.get(key, default)

    def setSetting(self, key: str, value) -> None:
        self.settings[key] = value
        self.commit()


def _init_settings():
    settings_dir = getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", None) or os.environ.get(
        "DECKY_PLUGIN_SETTINGS_DIR", "/tmp/deck-curfew-settings"
    )
    os.makedirs(settings_dir, exist_ok=True)
    if SettingsManager is not None:
        mgr = SettingsManager(name="settings", settings_directory=settings_dir)
        mgr.read()
        return mgr
    return _FileSettings(os.path.join(settings_dir, "settings.json"))


settings = _init_settings()


def _default_update_info() -> dict[str, Any]:
    return {
        "current": read_installed_version(PLUGIN_DIR),
        "latest": None,
        "updateAvailable": False,
        "downloadUrl": None,
        "releaseUrl": None,
        "error": None,
        "lastChecked": None,
        "needsReload": False,
    }


class Plugin:
    # Initialized before _main so early get_status calls never AttributeError.
    _update_info: dict[str, Any] = _default_update_info()
    _enforce_task: Optional[asyncio.Task] = None
    _update_task: Optional[asyncio.Task] = None

    async def _main(self):
        decky.logger.info("Deck Curfew backend starting")
        self._update_info = _default_update_info()
        self._ensure_defaults()
        self._enforce_task = asyncio.create_task(self._enforce_loop())
        self._update_task = asyncio.create_task(self._update_loop())

    async def _unload(self):
        decky.logger.info("Deck Curfew backend unloading")
        for name in ("_enforce_task", "_update_task"):
            task = getattr(self, name, None)
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    async def _uninstall(self):
        decky.logger.info("Deck Curfew uninstall")

    async def _migration(self):
        pass

    async def _enforce_loop(self):
        """Backend watchdog: while blocking, kill Steam game process trees."""
        while True:
            try:
                status = status_payload(self._load(), datetime.now())
                if status.get("shouldBlockPlay"):
                    killed = kill_running_steam_games()
                    if killed:
                        decky.logger.info("Curfew backend killed: %s", killed)
                        try:
                            await decky.emit("curfew_enforced", killed)
                        except Exception:
                            pass
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                decky.logger.error("Curfew enforce loop error: %s", exc)
            await asyncio.sleep(3)

    async def _update_loop(self):
        """Periodic GitHub release checks; auto-install when unlocked."""
        await asyncio.sleep(20)  # let Steam/network settle after boot
        while True:
            try:
                cfg = self._load()
                if cfg.get("autoUpdate", True):
                    await self._refresh_update_info()
                    info = self._update_info
                    now = datetime.now()
                    if (
                        info.get("updateAvailable")
                        and info.get("downloadUrl")
                        and not is_locked(cfg, now)
                        and session_phase(cfg, now) != "active"
                    ):
                        decky.logger.info("Auto-installing update %s", info.get("latest"))
                        await self._install_update_internal()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                decky.logger.error("Curfew update loop error: %s", exc)
            await asyncio.sleep(UPDATE_CHECK_SECONDS)

    async def _refresh_update_info(self) -> dict[str, Any]:
        current = read_installed_version(PLUGIN_DIR)
        info = await asyncio.to_thread(check_latest_release, current)
        info["lastChecked"] = datetime.now().isoformat(timespec="seconds")
        info["needsReload"] = bool(self._update_info.get("needsReload"))
        self._update_info = info
        return info

    async def _install_update_internal(self) -> dict[str, Any]:
        info = self._update_info or {}
        url = info.get("downloadUrl")
        if not url:
            info = await self._refresh_update_info()
            url = info.get("downloadUrl")
        if not url:
            raise Exception(info.get("error") or "No update download URL available")

        result = await asyncio.to_thread(install_from_zip_url, url, PLUGIN_DIR)
        self._update_info["needsReload"] = True
        self._update_info["updateAvailable"] = False
        self._update_info["current"] = result.get("installedVersion")
        try:
            await decky.emit("curfew_updated", result.get("installedVersion"))
        except Exception:
            pass
        # Best-effort Decky restart (may require passwordless sudo)
        try:
            proc = await asyncio.create_subprocess_exec(
                "systemctl",
                "restart",
                "plugin_loader.service",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()
        except Exception:
            pass
        return {
            **self._update_info,
            "installed": True,
            "installedVersion": result.get("installedVersion"),
        }

    def _ensure_defaults(self) -> dict[str, Any]:
        raw = settings.getSetting(SETTINGS_KEY, None)
        normalized = normalize_settings(raw)
        now = datetime.now()
        cleaned = clear_expired_session_fields(normalized, now)
        if cleaned != normalized or raw != cleaned:
            settings.setSetting(SETTINGS_KEY, cleaned)
            if hasattr(settings, "commit"):
                settings.commit()
            return cleaned
        return normalized

    def _load(self) -> dict[str, Any]:
        return self._ensure_defaults()

    def _save(self, data: dict[str, Any]) -> dict[str, Any]:
        normalized = normalize_settings(data)
        settings.setSetting(SETTINGS_KEY, normalized)
        if hasattr(settings, "commit"):
            settings.commit()
        return normalized

    def _status(self) -> dict[str, Any]:
        version = read_installed_version(PLUGIN_DIR)
        status = status_payload(self._load(), datetime.now())
        status["pluginVersion"] = version
        update = getattr(self, "_update_info", None) or _default_update_info()
        if not update.get("current"):
            update = {**update, "current": version}
        status["update"] = update
        return status

    async def get_status(self) -> dict[str, Any]:
        try:
            return self._status()
        except Exception as exc:
            decky.logger.error("get_status failed: %s", exc)
            version = read_installed_version(PLUGIN_DIR)
            return {
                "now": datetime.now().isoformat(timespec="seconds"),
                "locked": False,
                "lockedUntil": None,
                "sessionStartsAt": None,
                "sessionPhase": "none",
                "sessionActive": False,
                "scheduleLocked": False,
                "playAllowed": True,
                "shouldBlockPlay": False,
                "blockAction": "terminate",
                "warnMinutes": 5,
                "minutesToCutoff": None,
                "countdownSeconds": None,
                "shouldWarn": False,
                "cutoffAt": None,
                "allowAt": None,
                "nextBlockAt": None,
                "scheduleSummary": None,
                "statusLine": f"Status error: {exc}",
                "nextLine": None,
                "lockLine": None,
                "pluginVersion": version,
                "update": getattr(self, "_update_info", None) or _default_update_info(),
                "settings": normalize_settings(None),
            }

    async def get_settings(self) -> dict[str, Any]:
        return self._load()

    async def check_for_update(self) -> dict[str, Any]:
        return await self._refresh_update_info()

    async def install_update(self) -> dict[str, Any]:
        cfg = self._load()
        now = datetime.now()
        if is_locked(cfg, now) or session_phase(cfg, now) == "active":
            raise Exception("Cannot install updates while a session/lock is active.")
        return await self._install_update_internal()

    async def set_auto_update(self, enabled: bool) -> dict[str, Any]:
        cfg = self._load()
        now = datetime.now()
        if is_locked(cfg, now):
            raise Exception("Curfew is locked — settings cannot be changed.")
        cfg["autoUpdate"] = bool(enabled)
        self._save(cfg)
        return self._status()

    async def enforce_now(self) -> dict[str, Any]:
        """Frontend-triggered enforce: kill games if currently blocking."""
        status = self._status()
        killed: list = []
        if status.get("shouldBlockPlay"):
            killed = kill_running_steam_games()
            if killed:
                decky.logger.info("Curfew enforce_now killed: %s", killed)
        status["killed"] = killed
        return status

    async def update_schedule(self, patch: dict[str, Any]) -> dict[str, Any]:
        """Update schedule fields. Refuses while locked."""
        cfg = self._load()
        now = datetime.now()
        if is_locked(cfg, now):
            raise Exception("Curfew is locked — schedule cannot be changed until the commitment ends.")

        allowed_keys = {
            "mode",
            "warnMinutes",
            "blockAfter",
            "weekendBlockAfter",
            "days",
            "autoUpdate",
        }
        for key, value in (patch or {}).items():
            if key in allowed_keys:
                cfg[key] = value

        if cfg.get("blockAfter"):
            parse_hhmm(cfg["blockAfter"])
        if cfg.get("weekendBlockAfter"):
            parse_hhmm(cfg["weekendBlockAfter"])

        cfg["blockAction"] = "terminate"
        self._save(cfg)
        return self._status()

    async def lock_curfew(self, until_iso: str) -> dict[str, Any]:
        """Lock settings until until_iso. No unlock API — wait for expiry."""
        cfg = self._load()
        now = datetime.now()
        if is_locked(cfg, now):
            raise Exception("Curfew is already locked.")

        try:
            until = datetime.fromisoformat(until_iso)
        except ValueError as exc:
            raise Exception(f"Invalid lock end time: {until_iso}") from exc

        if until <= now:
            raise Exception("Lock end must be in the future.")

        if until - now > timedelta(days=365):
            raise Exception("Lock commitment cannot exceed 365 days.")

        cfg["lockedUntil"] = until.replace(microsecond=0).isoformat()
        cfg["sessionStartsAt"] = None
        cfg["blockAction"] = "terminate"
        self._save(cfg)
        decky.logger.info("Curfew locked until %s", cfg["lockedUntil"])
        return self._status()

    async def lock_preset(self, preset: str) -> dict[str, Any]:
        """Convenience presets: tomorrow_8, days_3, days_7."""
        now = datetime.now()
        if preset == "tomorrow_8":
            tomorrow = (now + timedelta(days=1)).replace(hour=8, minute=0, second=0, microsecond=0)
            until = tomorrow
        elif preset == "days_3":
            until = (now + timedelta(days=3)).replace(microsecond=0)
        elif preset == "days_7":
            until = (now + timedelta(days=7)).replace(microsecond=0)
        else:
            raise Exception(f"Unknown lock preset: {preset}")
        return await self.lock_curfew(until.isoformat())

    async def start_session(self, duration_minutes: int, delay_minutes: int = 0) -> dict[str, Any]:
        """
        Timed session: block all games for `duration_minutes`,
        optionally starting after `delay_minutes` (countdown only until then).
        Once active, settings stay frozen until the session ends — no cancel.
        A pending countdown can be replaced or cancelled.
        """
        cfg = self._load()
        now = datetime.now()
        phase = session_phase(cfg, now)
        if phase == "active" or (is_locked(cfg, now) and phase == "none"):
            raise Exception("Already locked — wait for the current session/commitment to end.")

        try:
            duration_minutes = int(duration_minutes)
            delay_minutes = int(delay_minutes)
            session = build_session(now, duration_minutes, delay_minutes)
        except (TypeError, ValueError) as exc:
            raise Exception(str(exc)) from exc

        cfg["sessionStartsAt"] = session["sessionStartsAt"]
        cfg["lockedUntil"] = session["lockedUntil"]
        cfg["blockAction"] = "terminate"
        self._save(cfg)
        decky.logger.info(
            "Session armed: start=%s end=%s",
            cfg["sessionStartsAt"],
            cfg["lockedUntil"],
        )
        status = self._status()
        if status.get("shouldBlockPlay"):
            killed = kill_running_steam_games()
            status["killed"] = killed
        return status

    async def cancel_pending_session(self) -> dict[str, Any]:
        """Cancel a future countdown. Refuses if the session has already become active."""
        cfg = self._load()
        now = datetime.now()
        phase = session_phase(cfg, now)
        if phase == "active":
            raise Exception("Session is already active — it cannot be cancelled.")
        if phase != "pending":
            raise Exception("No upcoming session to cancel.")

        cfg["sessionStartsAt"] = None
        cfg["lockedUntil"] = None
        self._save(cfg)
        decky.logger.info("Pending session cancelled")
        return self._status()
