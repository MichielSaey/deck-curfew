import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py_modules"))
from updater import is_newer, parse_version  # noqa: E402


class TestUpdater(unittest.TestCase):
    def test_parse_version(self):
        self.assertEqual(parse_version("0.3.0"), (0, 3, 0))
        self.assertEqual(parse_version("v1.2.3"), (1, 2, 3))
        self.assertEqual(parse_version("0.2"), (0, 2, 0))

    def test_is_newer(self):
        self.assertTrue(is_newer("0.3.0", "0.2.3"))
        self.assertFalse(is_newer("0.2.3", "0.3.0"))
        self.assertFalse(is_newer("0.3.0", "0.3.0"))


if __name__ == "__main__":
    unittest.main()
