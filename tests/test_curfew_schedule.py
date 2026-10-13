import os
import sys
import unittest
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py_modules"))
from curfew_schedule import (
    build_session,
    default_settings,
    is_locked,
    is_play_allowed,
    next_cutoff,
    session_phase,
    status_payload,
)


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.cfg = default_settings()
        self.cfg["lockedUntil"] = "2099-01-01T00:00:00"
        self.cfg["mode"] = "block_after"
        self.cfg["blockAfter"] = "21:00"
        self.cfg["weekendBlockAfter"] = "22:00"

    def test_unlocked_always_allows(self):
        self.cfg["lockedUntil"] = None
        now = datetime(2026, 10, 13, 23, 0)  # Tue
        self.assertFalse(is_locked(self.cfg, now))
        self.assertTrue(is_play_allowed(self.cfg, now))

    def test_block_after_weekday(self):
        before = datetime(2026, 10, 13, 20, 59)  # Tue
        after = datetime(2026, 10, 13, 21, 0)
        self.assertTrue(is_play_allowed(self.cfg, before))
        self.assertFalse(is_play_allowed(self.cfg, after))

    def test_block_after_weekend(self):
        before = datetime(2026, 10, 17, 21, 30)  # Sat
        after = datetime(2026, 10, 17, 22, 0)
        self.assertTrue(is_play_allowed(self.cfg, before))
        self.assertFalse(is_play_allowed(self.cfg, after))

    def test_expired_lock(self):
        self.cfg["lockedUntil"] = "2020-01-01T00:00:00"
        now = datetime(2026, 10, 13, 23, 0)
        self.assertFalse(is_locked(self.cfg, now))
        self.assertTrue(is_play_allowed(self.cfg, now))

    def test_allow_windows_fail_closed(self):
        self.cfg["mode"] = "allow_windows"
        self.cfg["days"] = {k: [] for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
        now = datetime(2026, 10, 13, 12, 0)
        self.assertFalse(is_play_allowed(self.cfg, now))

    def test_allow_windows_inside(self):
        self.cfg["mode"] = "allow_windows"
        self.cfg["days"]["tue"] = [{"start": "18:00", "end": "21:00"}]
        inside = datetime(2026, 10, 13, 19, 0)
        outside = datetime(2026, 10, 13, 21, 0)
        self.assertTrue(is_play_allowed(self.cfg, inside))
        self.assertFalse(is_play_allowed(self.cfg, outside))

    def test_next_cutoff(self):
        now = datetime(2026, 10, 13, 20, 0)
        cutoff = next_cutoff(self.cfg, now)
        self.assertEqual(cutoff, datetime(2026, 10, 13, 21, 0))

    def test_should_warn(self):
        self.cfg["warnMinutes"] = 5
        now = datetime(2026, 10, 13, 20, 56)
        payload = status_payload(self.cfg, now)
        self.assertTrue(payload["shouldWarn"])
        self.assertTrue(payload["playAllowed"])
        self.assertTrue(payload["locked"])


class SessionTests(unittest.TestCase):
    def test_build_session_now(self):
        now = datetime(2026, 10, 13, 14, 0, 0)
        session = build_session(now, duration_minutes=5, delay_minutes=0)
        self.assertEqual(session["sessionStartsAt"], "2026-10-13T14:00:00")
        self.assertEqual(session["lockedUntil"], "2026-10-13T14:05:00")

    def test_build_session_delayed(self):
        now = datetime(2026, 10, 13, 14, 0, 0)
        session = build_session(now, duration_minutes=5, delay_minutes=1)
        self.assertEqual(session["sessionStartsAt"], "2026-10-13T14:01:00")
        self.assertEqual(session["lockedUntil"], "2026-10-13T14:06:00")

    def test_pending_is_countdown_not_active(self):
        now = datetime(2026, 10, 13, 14, 0, 0)
        cfg = default_settings()
        cfg.update(build_session(now, 5, delay_minutes=2))
        self.assertEqual(session_phase(cfg, now), "pending")
        self.assertFalse(is_locked(cfg, now))
        self.assertTrue(is_play_allowed(cfg, now))
        payload = status_payload(cfg, now)
        self.assertFalse(payload["sessionActive"])
        self.assertFalse(payload["shouldBlockPlay"])
        self.assertEqual(payload["countdownSeconds"], 120)
        self.assertIn("Countdown", payload["statusLine"])
        self.assertIn("not active", payload["statusLine"])

    def test_active_blocks_play(self):
        now = datetime(2026, 10, 13, 14, 0, 0)
        cfg = default_settings()
        cfg.update(build_session(now - timedelta(minutes=1), 5, delay_minutes=0))
        # Session started 1 min ago, ends in 4 min
        self.assertEqual(session_phase(cfg, now), "active")
        self.assertTrue(is_locked(cfg, now))
        self.assertFalse(is_play_allowed(cfg, now))
        payload = status_payload(cfg, now)
        self.assertTrue(payload["sessionActive"])
        self.assertTrue(payload["shouldBlockPlay"])
        self.assertEqual(payload["sessionPhase"], "active")
        self.assertEqual(payload["countdownSeconds"], 4 * 60)

    def test_expired_session_clears_via_is_locked(self):
        now = datetime(2026, 10, 13, 15, 0, 0)
        cfg = default_settings()
        cfg["sessionStartsAt"] = "2026-10-13T14:00:00"
        cfg["lockedUntil"] = "2026-10-13T14:05:00"
        self.assertFalse(is_locked(cfg, now))
        self.assertTrue(is_play_allowed(cfg, now))


if __name__ == "__main__":
    unittest.main()
