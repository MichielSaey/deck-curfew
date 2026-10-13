import os
import sys
import unittest
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py_modules"))
from curfew_schedule import (
    default_settings,
    is_locked,
    is_play_allowed,
    next_cutoff,
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


if __name__ == "__main__":
    unittest.main()
