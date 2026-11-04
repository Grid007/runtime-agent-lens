"""Benchmark fixture: a failing unit test for the test-debugging scenario."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from loyalty import load_orders, report


class LoyaltyTest(unittest.TestCase):
    def test_c017_points(self):
        totals = report(load_orders(Path(__file__).with_name("orders.json")))
        self.assertEqual(totals["C017"], 1659)


if __name__ == "__main__":
    unittest.main()
