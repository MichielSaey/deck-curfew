"""Pure schedule + lock evaluation for Deck Curfew."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def default_settings() -> dict[str, Any]:
    return {
        "lockedUntil": None,
        "timezone": "local",
        "mode": "block_after",
        "warnMinutes": 5,
        "blockAction": "terminate",
        "blockAfter": "21:00",
        "weekendBlockAfter": "22:00",
        "days": {
            "mon": [{"start": "00:00", "end": "21:00"}],
            "tue": [{"start": "00:00", "end": "21:00"}],
            "wed": [{"start": "00:00", "end": "21:00"}],
            "thu": [{"start": "00:00", "end": "21:00"}],
            "fri": [{"start": "00:00", "end": "22:00"}],
            "sat": [{"start": "00:00", "end": "22:00"}],
            "sun": [{"start": "00:00", "end": "21:00"}],
        },
    }


def parse_hhmm(value: str) -> tuple[int, int]:
    parts = value.strip().split(":")
    if len(parts) != 2:
        raise ValueError(f"Invalid time: {value}")
    hour = int(parts[0])
    minute = int(parts[1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"Invalid time: {value}")
    return hour, minute


def minutes_since_midnight(value: str) -> int:
    hour, minute = parse_hhmm(value)
    return hour * 60 + minute


def day_key(now: datetime) -> str:
    # Monday=0 … Sunday=6
    return DAY_KEYS[now.weekday()]


def is_weekend(now: datetime) -> bool:
    return now.weekday() >= 5


def normalize_settings(raw: Optional[dict[str, Any]]) -> dict[str, Any]:
    base = default_settings()
    if not raw:
        return base
    merged = {**base, **raw}
    if "days" in raw and isinstance(raw["days"], dict):
        days = dict(base["days"])
        days.update(raw["days"])
        merged["days"] = days
    warn = int(merged.get("warnMinutes", 5))
    merged["warnMinutes"] = max(0, min(120, warn))
    merged["blockAction"] = "terminate"
    if merged.get("mode") not in ("block_after", "allow_windows"):
        merged["mode"] = "block_after"
    return merged


def is_locked(settings: dict[str, Any], now: datetime) -> bool:
    locked_until = settings.get("lockedUntil")
    if not locked_until:
        return False
    try:
        end = datetime.fromisoformat(locked_until)
    except ValueError:
        return False
    return now < end


def effective_block_after(settings: dict[str, Any], now: datetime) -> str:
    if is_weekend(now) and settings.get("weekendBlockAfter"):
        return settings["weekendBlockAfter"]
    return settings.get("blockAfter") or "21:00"


def windows_for_day(settings: dict[str, Any], now: datetime) -> list[dict[str, str]]:
    days = settings.get("days") or {}
    windows = days.get(day_key(now)) or []
    return [w for w in windows if "start" in w and "end" in w]


def is_play_allowed(settings: dict[str, Any], now: datetime) -> bool:
    """Play is only restricted while locked. Unlocked = always allowed."""
    if not is_locked(settings, now):
        return True

    mode = settings.get("mode", "block_after")
    current = now.hour * 60 + now.minute

    if mode == "allow_windows":
        windows = windows_for_day(settings, now)
        # Fail closed: locked + no windows => blocked
        if not windows:
            return False
        for window in windows:
            start = minutes_since_midnight(window["start"])
            end = minutes_since_midnight(window["end"])
            if start == end:
                continue
            if start < end:
                if start <= current < end:
                    return True
            else:
                # Overnight window, e.g. 22:00–02:00
                if current >= start or current < end:
                    return True
        return False

    # block_after: allowed from 00:00 until blockAfter (exclusive)
    cutoff = minutes_since_midnight(effective_block_after(settings, now))
    return current < cutoff


def next_cutoff(settings: dict[str, Any], now: datetime) -> Optional[datetime]:
    """Next moment play becomes disallowed (while locked)."""
    if not is_locked(settings, now):
        return None

    mode = settings.get("mode", "block_after")
    if mode == "block_after":
        cutoff_m = minutes_since_midnight(effective_block_after(settings, now))
        candidate = now.replace(hour=cutoff_m // 60, minute=cutoff_m % 60, second=0, microsecond=0)
        if candidate <= now:
            # tomorrow's cutoff (recompute weekend/weekday for tomorrow)
            tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            cut = minutes_since_midnight(effective_block_after(settings, tomorrow))
            return tomorrow.replace(hour=cut // 60, minute=cut % 60)
        return candidate

    # allow_windows: end of current window, or None if already blocked
    windows = windows_for_day(settings, now)
    current = now.hour * 60 + now.minute
    ends: list[datetime] = []
    for window in windows:
        start = minutes_since_midnight(window["start"])
        end = minutes_since_midnight(window["end"])
        if start < end and start <= current < end:
            ends.append(now.replace(hour=end // 60, minute=end % 60, second=0, microsecond=0))
        elif start > end and (current >= start or current < end):
            if current >= start:
                nxt = (now + timedelta(days=1)).replace(
                    hour=end // 60, minute=end % 60, second=0, microsecond=0
                )
                ends.append(nxt)
            else:
                ends.append(now.replace(hour=end // 60, minute=end % 60, second=0, microsecond=0))
    return min(ends) if ends else None


def next_allow(settings: dict[str, Any], now: datetime) -> Optional[datetime]:
    """Next moment play becomes allowed again (while locked and currently blocked)."""
    if not is_locked(settings, now) or is_play_allowed(settings, now):
        return None

    mode = settings.get("mode", "block_after")
    if mode == "block_after":
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        return tomorrow

    # allow_windows: next window start within 7 days
    for offset in range(0, 8):
        day = (now + timedelta(days=offset)).replace(second=0, microsecond=0)
        windows = windows_for_day(settings, day)
        current = now.hour * 60 + now.minute if offset == 0 else -1
        for window in sorted(windows, key=lambda w: minutes_since_midnight(w["start"])):
            start = minutes_since_midnight(window["start"])
            if offset == 0 and start <= current:
                continue
            return day.replace(hour=start // 60, minute=start % 60)
    return None


def status_payload(settings: dict[str, Any], now: Optional[datetime] = None) -> dict[str, Any]:
    now = now or datetime.now()
    settings = normalize_settings(settings)
    locked = is_locked(settings, now)
    play_allowed = is_play_allowed(settings, now)
    cutoff = next_cutoff(settings, now) if locked and play_allowed else None
    allow_at = next_allow(settings, now) if locked and not play_allowed else None

    warn_minutes = int(settings.get("warnMinutes", 5))
    minutes_to_cutoff: Optional[int] = None
    should_warn = False
    if cutoff is not None:
        delta = cutoff - now
        minutes_to_cutoff = max(0, int(delta.total_seconds() // 60))
        should_warn = 0 < delta.total_seconds() <= warn_minutes * 60

    if not locked:
        status_line = "Unlocked — curfew not enforcing"
    elif play_allowed and cutoff is not None:
        status_line = f"Play allowed until {cutoff.strftime('%H:%M')}"
    elif play_allowed:
        status_line = "Play allowed"
    elif allow_at is not None:
        status_line = f"Blocked until {allow_at.strftime('%a %H:%M')}"
    else:
        status_line = "Blocked"

    lock_line = None
    if locked and settings.get("lockedUntil"):
        end = datetime.fromisoformat(settings["lockedUntil"])
        lock_line = f"Settings locked until {end.strftime('%a %Y-%m-%d %H:%M')}"

    return {
        "now": now.isoformat(timespec="seconds"),
        "locked": locked,
        "lockedUntil": settings.get("lockedUntil"),
        "playAllowed": play_allowed,
        "shouldBlockPlay": locked and not play_allowed,
        "blockAction": "terminate",
        "warnMinutes": warn_minutes,
        "minutesToCutoff": minutes_to_cutoff,
        "shouldWarn": should_warn,
        "cutoffAt": cutoff.isoformat(timespec="seconds") if cutoff else None,
        "allowAt": allow_at.isoformat(timespec="seconds") if allow_at else None,
        "statusLine": status_line,
        "lockLine": lock_line,
        "settings": settings,
    }
