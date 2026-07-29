import unittest
import time

from marketintel_data import (
    build_cross_source_checks,
    build_identity_checks,
    calculate_operating_expense_runway,
    fetch_fred_snapshot,
    normalize_debt_to_equity,
    normalize_dividend_yield,
)


class FinancialDataTests(unittest.TestCase):
    def test_dividend_yield_accepts_decimal_and_percent(self):
        self.assertEqual(normalize_dividend_yield(0.0167), 1.67)
        self.assertEqual(normalize_dividend_yield(1.67), 1.67)

    def test_debt_to_equity_is_displayed_as_ratio(self):
        self.assertEqual(normalize_debt_to_equity(388.9), 3.889)
        self.assertEqual(normalize_debt_to_equity(1.25), 1.25)

    def test_original_runway_formula_is_preserved(self):
        monthly, months = calculate_operating_expense_runway(
            12_000_000, 24_000_000
        )
        self.assertEqual(monthly, 2_000_000)
        self.assertEqual(months, 6.0)

    def test_financial_identities(self):
        checks = build_identity_checks({
            'price': 100,
            'shares_outstanding': 10,
            'market_cap': 1_000,
            'eps': 5,
            'pe': 20,
            'revenue_ttm': 200,
            'revenue_ttm_calculated': 200,
            'revenue_quarters_count': 4,
            'net_income_ttm': 40,
            'profit_margin': 20,
        })
        self.assertTrue(all(check['status'] == 'pass' for check in checks))

    def test_cross_source_review_is_explicit(self):
        checks = build_cross_source_checks(
            {'revenue_ttm': 100},
            {'revenue_ttm': 130},
            {},
        )
        self.assertEqual(checks[0]['status'], 'review')
        self.assertEqual(checks[0]['id'], 'fmp_revenue')

    def test_fred_series_are_loaded_in_parallel(self):
        class Response:
            def raise_for_status(self):
                return None

            def json(self):
                return {
                    'observations': [
                        {'date': f'2026-{month:02d}-01', 'value': str(100 + month)}
                        for month in range(12, 0, -1)
                    ] + [{'date': '2025-12-01', 'value': '100'}]
                }

        class SlowRequests:
            def __init__(self):
                self.calls = 0

            def get(self, *args, **kwargs):
                self.calls += 1
                time.sleep(0.05)
                return Response()

        requests_module = SlowRequests()
        started = time.perf_counter()
        result = fetch_fred_snapshot(requests_module, 'test-key')
        elapsed = time.perf_counter() - started

        self.assertEqual(result['status'], 'ok')
        self.assertEqual(len(result['series']), 8)
        self.assertEqual(requests_module.calls, 8)
        self.assertLess(elapsed, 0.30)


if __name__ == '__main__':
    unittest.main()
