"""Pure schedule + lock evaluation for Deck Curfew."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def default_settings() -> dict[str, Any]:
    return {
        "lockedUntil": None,
        # Timed session: block all play between sessionStartsAt and lockedUntil.
        # If sessionStartsAt is null while locked, enforce the daily schedule instead.
        "sessionStartsAt": None,
        "timezone": "local",
        "mode": "block_after",
        "warnMinutes": 5,
        "blockAction": "terminate",
        "blockAfter": "21:00",
        "weekendBlockAfter": "22:00",
        "autoUpdate": True,
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
    merged["autoUpdate"] = bool(merged.get("autoUpdate", True))
    for key in ("lockedUntil", "sessionStartsAt"):
        if merged.get(key) == "":
            merged[key] = None
    return merged


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def is_session_lock(settings: dict[str, Any]) -> bool:
    """True when lockedUntil is paired with a session start."""
    return bool(settings.get("sessionStartsAt") and settings.get("lockedUntil"))


def session_phase(settings: dict[str, Any], now: datetime) -> str:
    """none | pending | active — for timed sessions only."""
    if not is_session_lock(settings):
        return "none"
    start = _parse_iso(settings.get("sessionStartsAt"))
    end = _parse_iso(settings.get("lockedUntil"))
    if start is None or end is None or now >= end:
        return "none"
    if now < start:
        return "pending"
    return "active"


def is_locked(settings: dict[str, Any], now: datetime) -> bool:
    """
    True only while enforcement commitment is in force.
    Pending (future) sessions are NOT locked — countdown only, play allowed.
    """
    phase = session_phase(settings, now)
    if phase == "pending":
        return False
    if phase == "active":
        return True
    end = _parse_iso(settings.get("lockedUntil"))
    if end is None:
        return False
    # Schedule lock (no session): locked until end
    if settings.get("sessionStartsAt"):
        return False
    return now < end


def clear_expired_session_fields(settings: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Clear session/lock fields that have fully ended."""
    end = _parse_iso(settings.get("lockedUntil"))
    if end is not None and now >= end:
        settings = {**settings, "lockedUntil": None, "sessionStartsAt": None}
    return settings


def format_countdown(total_seconds: int) -> str:
    total_seconds = max(0, int(total_seconds))
    hours, rem = divmod(total_seconds, 3600)
    minutes, seconds = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def effective_block_after(settings: dict[str, Any], now: datetime) -> str:
    if is_weekend(now) and settings.get("weekendBlockAfter"):
        return settings["weekendBlockAfter"]
    return settings.get("blockAfter") or "21:00"


def windows_for_day(settings: dict[str, Any], now: datetime) -> list[dict[str, str]]:
    days = settings.get("days") or {}
    windows = days.get(day_key(now)) or []
    return [w for w in windows if "start" in w and "end" in w]


def is_play_allowed(settings: dict[str, Any], now: datetime) -> bool:
    """Play is only restricted while locked/active. Pending countdown = allowed."""
    phase = session_phase(settings, now)
    if phase == "pending":
        return True
    if phase == "active":
        return False
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


def next_block_after_cutoff(settings: dict[str, Any], now: datetime) -> Optional[datetime]:
    """Next daily block-after cutoff (ignores lock/session)."""
    mode = settings.get("mode", "block_after")
    if mode != "block_after":
        return None
    cutoff_m = minutes_since_midnight(effective_block_after(settings, now))
    candidate = now.replace(hour=cutoff_m // 60, minute=cutoff_m % 60, second=0, microsecond=0)
    if candidate <= now:
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        cut = minutes_since_midnight(effective_block_after(settings, tomorrow))
        return tomorrow.replace(hour=cut // 60, minute=cut % 60)
    return candidate


def next_cutoff(settings: dict[str, Any], now: datetime) -> Optional[datetime]:
    """Next moment play becomes disallowed."""
    phase = session_phase(settings, now)
    if phase == "pending":
        return _parse_iso(settings.get("sessionStartsAt"))
    if phase == "active":
        return None
    if not is_locked(settings, now):
        return None

    mode = settings.get("mode", "block_after")
    if mode == "block_after":
        return next_block_after_cutoff(settings, now)

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

    if session_phase(settings, now) == "active":
        return _parse_iso(settings.get("lockedUntil"))

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


def build_session(now: datetime, duration_minutes: int, delay_minutes: int = 0) -> dict[str, str]:
    """Return sessionStartsAt / lockedUntil for a timed block session."""
    if duration_minutes < 1:
        raise ValueError("Session duration must be at least 1 minute")
    if duration_minutes > 24 * 60:
        raise ValueError("Session duration cannot exceed 24 hours")
    if delay_minutes < 0:
        raise ValueError("Delay cannot be negative")
    if delay_minutes > 24 * 60:
        raise ValueError("Delay cannot exceed 24 hours")

    start = (now + timedelta(minutes=delay_minutes)).replace(microsecond=0)
    end = (start + timedelta(minutes=duration_minutes)).replace(microsecond=0)
    return {
        "sessionStartsAt": start.isoformat(),
        "lockedUntil": end.isoformat(),
    }


def status_payload(settings: dict[str, Any], now: Optional[datetime] = None) -> dict[str, Any]:
    now = now or datetime.now()
    settings = normalize_settings(settings)
    phase = session_phase(settings, now)
    locked = is_locked(settings, now)
    play_allowed = is_play_allowed(settings, now)
    session_active = phase == "active"
    schedule_locked = locked and phase == "none"

    cutoff = next_cutoff(settings, now) if (phase == "pending" or (locked and play_allowed)) else None
    allow_at = next_allow(settings, now) if (session_active or (locked and not play_allowed)) else None
    next_block = next_block_after_cutoff(settings, now)

    warn_minutes = int(settings.get("warnMinutes", 5))
    minutes_to_cutoff: Optional[int] = None
    countdown_seconds: Optional[int] = None
    should_warn = False

    if phase == "pending":
        start = _parse_iso(settings.get("sessionStartsAt"))
        if start is not None:
            countdown_seconds = max(0, int((start - now).total_seconds()))
            cutoff = start
            minutes_to_cutoff = countdown_seconds // 60
            should_warn = 0 < countdown_seconds <= max(warn_minutes, 1) * 60
    elif phase == "active":
        end = _parse_iso(settings.get("lockedUntil"))
        if end is not None:
            countdown_seconds = max(0, int((end - now).total_seconds()))
            allow_at = end
    elif cutoff is not None:
        delta = cutoff - now
        countdown_seconds = max(0, int(delta.total_seconds()))
        minutes_to_cutoff = countdown_seconds // 60
        should_warn = 0 < countdown_seconds <= warn_minutes * 60

    weekday = settings.get("blockAfter") or "21:00"
    weekend = settings.get("weekendBlockAfter") or "22:00"
    schedule_summary = f"Weekdays after {weekday} · weekends after {weekend}"

    if phase == "pending" and countdown_seconds is not None:
        status_line = f"Session starts in {format_countdown(countdown_seconds)}"
        next_line = "Games stay allowed until the countdown ends"
    elif phase == "active" and countdown_seconds is not None:
        status_line = f"Session active — {format_countdown(countdown_seconds)} left"
        next_line = "All games blocked until the timer ends"
    elif phase == "active":
        status_line = "Session active — games blocked"
        next_line = None
    elif schedule_locked and play_allowed and cutoff is not None:
        status_line = f"Schedule locked — play until {cutoff.strftime('%H:%M')}"
        next_line = f"Next block at {cutoff.strftime('%a %H:%M')}"
    elif schedule_locked and play_allowed:
        status_line = "Schedule locked — play allowed"
        next_line = schedule_summary
    elif schedule_locked and allow_at is not None:
        status_line = f"Schedule locked — blocked until {allow_at.strftime('%a %H:%M')}"
        next_line = schedule_summary
    elif schedule_locked:
        status_line = "Schedule locked — games blocked"
        next_line = schedule_summary
    else:
        status_line = "Schedule unlocked — not enforcing yet"
        if next_block is not None:
            next_line = f"If locked, next block at {next_block.strftime('%a %H:%M')}"
        else:
            next_line = schedule_summary

    lock_line = None
    if phase == "pending" and settings.get("sessionStartsAt"):
        start = datetime.fromisoformat(settings["sessionStartsAt"])
        end = datetime.fromisoformat(settings["lockedUntil"]) if settings.get("lockedUntil") else None
        if end:
            lock_line = (
                f"Armed {start.strftime('%H:%M')} → {end.strftime('%H:%M')} "
                "(cancel anytime before start)"
            )
        else:
            lock_line = f"Armed for {start.strftime('%H:%M')}"
    elif phase == "active" and settings.get("lockedUntil"):
        end = datetime.fromisoformat(settings["lockedUntil"])
        lock_line = f"No cancel — ends {end.strftime('%H:%M')}"
    elif schedule_locked and settings.get("lockedUntil"):
        end = datetime.fromisoformat(settings["lockedUntil"])
        lock_line = f"Settings frozen until {end.strftime('%a %Y-%m-%d %H:%M')}"

    return {
        "now": now.isoformat(timespec="seconds"),
        "locked": locked,
        "lockedUntil": settings.get("lockedUntil"),
        "sessionStartsAt": settings.get("sessionStartsAt"),
        "sessionPhase": phase,
        "sessionActive": session_active,
        "scheduleLocked": schedule_locked,
        "playAllowed": play_allowed,
        "shouldBlockPlay": session_active or (locked and not play_allowed),
        "blockAction": "terminate",
        "warnMinutes": warn_minutes,
        "minutesToCutoff": minutes_to_cutoff,
        "countdownSeconds": countdown_seconds,
        "shouldWarn": should_warn,
        "cutoffAt": cutoff.isoformat(timespec="seconds") if cutoff else None,
        "allowAt": allow_at.isoformat(timespec="seconds") if allow_at else None,
        "nextBlockAt": next_block.isoformat(timespec="seconds") if next_block else None,
        "scheduleSummary": schedule_summary,
        "statusLine": status_line,
        "nextLine": next_line,
        "lockLine": lock_line,
        "settings": settings,
    }
