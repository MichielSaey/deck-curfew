import os
import sys
from datetime import datetime, timedelta
from typing import Any, Optional

import decky

# Bundled pure schedule helpers
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

try:
    from settings import SettingsManager  # type: ignore
except ImportError:
    SettingsManager = None  # type: ignore

SETTINGS_KEY = "curfew"


class _FileSettings:
    """Fallback JSON settings when SettingsManager is unavailable (local tests)."""

    def __init__(self, path: str):
        self.path = path
        self.settings: dict[str, Any] = {}

    def read(self) -> None:
        import json

        if not os.path.isfile(self.path):
            self.settings = {}
            return
        with open(self.path, "r", encoding="utf-8") as fh:
            self.settings = json.load(fh)

    def commit(self) -> None:
        import json

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


class Plugin:
    async def _main(self):
        decky.logger.info("Deck Curfew backend starting")
        self._ensure_defaults()

    async def _unload(self):
        decky.logger.info("Deck Curfew backend unloading")

    async def _uninstall(self):
        decky.logger.info("Deck Curfew uninstall")

    async def _migration(self):
        pass

    def _ensure_defaults(self) -> dict[str, Any]:
        raw = settings.getSetting(SETTINGS_KEY, None)
        normalized = normalize_settings(raw)
        now = datetime.now()
        # Only drop fields after the end time — keep pending countdowns
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

    async def get_status(self) -> dict[str, Any]:
        cfg = self._load()
        return status_payload(cfg, datetime.now())

    async def get_settings(self) -> dict[str, Any]:
        return self._load()

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
        }
        for key, value in (patch or {}).items():
            if key in allowed_keys:
                cfg[key] = value

        # Validate times early
        if cfg.get("blockAfter"):
            parse_hhmm(cfg["blockAfter"])
        if cfg.get("weekendBlockAfter"):
            parse_hhmm(cfg["weekendBlockAfter"])

        cfg["blockAction"] = "terminate"
        saved = self._save(cfg)
        return status_payload(saved, now)

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

        # Sanity: max 365 days
        if until - now > timedelta(days=365):
            raise Exception("Lock commitment cannot exceed 365 days.")

        cfg["lockedUntil"] = until.replace(microsecond=0).isoformat()
        cfg["sessionStartsAt"] = None  # schedule lock, not a timed session
        cfg["blockAction"] = "terminate"
        saved = self._save(cfg)
        decky.logger.info("Curfew locked until %s", cfg["lockedUntil"])
        return status_payload(saved, now)

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
        saved = self._save(cfg)
        decky.logger.info(
            "Session armed: start=%s end=%s",
            cfg["sessionStartsAt"],
            cfg["lockedUntil"],
        )
        return status_payload(saved, now)

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
        saved = self._save(cfg)
        decky.logger.info("Pending session cancelled")
        return status_payload(saved, now)
