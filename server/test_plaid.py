"""Offline tests for the Plaid connection: a fake transport stands in for Plaid's API."""

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from plaid import Plaid, merge_portfolios
from server import App, Store

TODAY = dt.date(2026, 10, 21)

SECURITIES = [
    {"security_id": "s-ko", "ticker_symbol": "KO", "name": "Coca-Cola Co", "type": "equity", "close_price": 70.5, "sector": "Consumer Non-Durables"},
    {"security_id": "s-schd", "ticker_symbol": "SCHD", "name": "Schwab US Dividend Equity ETF", "type": "etf", "close_price": 28.4},
    {"security_id": "s-cash", "ticker_symbol": "CUR:USD", "name": "U S Dollar", "type": "cash", "is_cash_equivalent": True},
]
HOLDINGS = {
    "item": {"institution_id": "ins_54"},
    "accounts": [{"account_id": "a1", "type": "investment"}, {"account_id": "chk", "type": "depository"}],
    "securities": SECURITIES,
    "holdings": [
        {"account_id": "a1", "security_id": "s-ko", "quantity": 12, "institution_price": 71.0, "cost_basis": 660.0},
        {"account_id": "a1", "security_id": "s-schd", "quantity": 100, "institution_price": 28.5, "cost_basis": None},
        {"account_id": "a1", "security_id": "s-cash", "quantity": 250.25, "institution_value": 250.25},
    ],
}
TRANSACTIONS = [
    # Plaid amounts: negative = cash into the account.
    {"investment_transaction_id": "t1", "account_id": "a1", "security_id": "s-ko", "date": "2026-07-01", "type": "cash", "subtype": "dividend", "amount": -5.1, "quantity": 0, "name": "Dividend KO"},
    {"investment_transaction_id": "t2", "account_id": "a1", "security_id": "s-ko", "date": "2026-08-10", "type": "buy", "subtype": "buy", "amount": 140, "quantity": 2},
    {"investment_transaction_id": "t3", "account_id": "a1", "security_id": "s-ko", "date": "2026-10-01", "type": "cash", "subtype": "qualified dividend", "amount": -6.12, "quantity": 0},
    {"investment_transaction_id": "t4", "account_id": "a1", "security_id": "s-ko", "date": "2026-10-01", "type": "buy", "subtype": "dividend reinvestment", "amount": 6.12, "quantity": 0.0},
    {"investment_transaction_id": "t5", "account_id": "a1", "security_id": "s-schd", "date": "2026-09-25", "type": "cash", "subtype": "dividend", "amount": -26.0, "quantity": 0},
]


class FakePlaid:
    def __init__(self, tx_pages=None, errors=None):
        self.calls = []
        self.tx_pages = tx_pages or [TRANSACTIONS]
        self.errors = errors or {}  # path -> error_code

    def __call__(self, method, url, headers, body):
        path = url.removeprefix("https://sandbox.plaid.com")
        req = json.loads(body)
        self.calls.append((path, req))
        assert req["client_id"] == "cid" and req["secret"] == "sec"
        if path in self.errors:
            return 400, json.dumps({"error_code": self.errors[path], "error_message": "nope", "display_message": None}).encode()
        if path == "/link/token/create":
            return 200, b'{"link_token": "link-sandbox-123"}'
        if path == "/item/public_token/exchange":
            return 200, b'{"access_token": "access-sandbox-1", "item_id": "item-1"}'
        if path == "/item/remove":
            return 200, b"{}"
        if path == "/investments/holdings/get":
            return 200, json.dumps(HOLDINGS).encode()
        if path == "/investments/transactions/get":
            offset = req["options"]["offset"]
            total = sum(len(p) for p in self.tx_pages)
            page, seen = [], 0
            for p in self.tx_pages:
                if seen == offset:
                    page = p
                    break
                seen += len(p)
            return 200, json.dumps({"investment_transactions": page, "securities": SECURITIES, "total_investment_transactions": total}).encode()
        return 404, b'{"error_code": "NOT_FOUND"}'


def client(fake):
    return Plaid("cid", "sec", "sandbox", transport=fake)


class PlaidClientTests(unittest.TestCase):
    def test_link_token_new_and_update_mode(self):
        fake = FakePlaid()
        p = client(fake)
        self.assertEqual(p.link_token("u1"), "link-sandbox-123")
        self.assertEqual(fake.calls[0][1]["products"], ["investments"])
        p.link_token("u1", access_token="access-1")
        self.assertEqual(fake.calls[1][1]["access_token"], "access-1")
        self.assertNotIn("products", fake.calls[1][1])

    def test_fetch_item_maps_holdings_and_dividends(self):
        out = client(FakePlaid()).fetch_item("access", "item-1", TODAY)
        self.assertEqual(out["cash"], 250.25)
        ko, schd = out["holdings"]
        self.assertEqual((ko["symbol"], ko["shares"], ko["avgCost"], ko["price"]), ("KO", 12, 55.0, 71.0))
        self.assertEqual(ko["sector"], "Consumer Non-Durables")
        self.assertEqual((schd["avgCost"], schd["sector"]), (28.5, "ETF"))  # no cost basis → priced at today
        divs = {d["id"]: d for d in out["dividends"]}
        self.assertEqual(set(divs), {"plaid-t1", "plaid-t3", "plaid-t5"})  # DRIP buy isn't income
        # July: 12 shares today minus the 2 bought in August = 10, so $5.10 → $0.51/share.
        self.assertEqual((divs["plaid-t1"]["shares"], divs["plaid-t1"]["rate"]), (10, 0.51))
        self.assertEqual((divs["plaid-t3"]["shares"], divs["plaid-t3"]["rate"]), (12, 0.51))
        self.assertTrue(out["historyReady"])

    def test_paginates_transactions(self):
        fake = FakePlaid(tx_pages=[TRANSACTIONS[:2], TRANSACTIONS[2:]])
        out = client(fake).fetch_item("access", "item-1", TODAY)
        self.assertEqual(len(out["dividends"]), 3)
        offsets = [c[1]["options"]["offset"] for c in fake.calls if c[0] == "/investments/transactions/get"]
        self.assertEqual(offsets, [0, 2])

    def test_history_not_ready_still_returns_holdings(self):
        out = client(FakePlaid(errors={"/investments/transactions/get": "PRODUCT_NOT_READY"})).fetch_item("a", "i", TODAY)
        self.assertEqual(len(out["holdings"]), 2)
        self.assertFalse(out["historyReady"])

    def test_merge_keeps_old_dividends_and_previous_close(self):
        part = client(FakePlaid()).fetch_item("access", "item-1", TODAY)
        previous = {
            "syncedAt": "2026-10-20T18:30:00-04:00",
            "holdings": [{"symbol": "KO", "price": 70.0, "prevClose": 69.0}],
            "dividends": [{"id": "plaid-old", "symbol": "KO", "payDate": "2024-07-01", "amount": 4.0}],
        }
        merged = merge_portfolios([part], previous, "2026-10-21")
        ko = next(h for h in merged["holdings"] if h["symbol"] == "KO")
        self.assertEqual(ko["prevClose"], 70.0)  # yesterday's price
        self.assertEqual(merged["dividends"][-1]["id"], "plaid-old")
        # A second sync on the same day keeps the same previous close.
        merged2 = merge_portfolios([part], {**previous, "syncedAt": "2026-10-21T09:00:00-04:00",
                                             "holdings": [{"symbol": "KO", "price": 71.0, "prevClose": 70.0}]}, "2026-10-21")
        self.assertEqual(next(h for h in merged2["holdings"] if h["symbol"] == "KO")["prevClose"], 70.0)

    def test_merge_combines_two_logins(self):
        a = {"holdings": [{"symbol": "KO", "shares": 10, "avgCost": 50, "price": 70, "prevClose": 70}], "dividends": [], "cash": 1}
        b = {"holdings": [{"symbol": "KO", "shares": 10, "avgCost": 60, "price": 70, "prevClose": 70}], "dividends": [], "cash": 2}
        m = merge_portfolios([a, b], None, "2026-10-21")
        self.assertEqual((m["holdings"][0]["shares"], m["holdings"][0]["avgCost"], m["cash"]), (20, 55, 3))


class PlaidAppTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name))
        self.fake = FakePlaid()
        self.app = App(self.store, plaid=client(self.fake))

    def tearDown(self):
        self.tmp.cleanup()

    def test_link_sync_and_unlink(self):
        self.assertFalse(self.app.status()["connected"])
        self.assertEqual(self.app.link_token()["linkToken"], "link-sandbox-123")
        st = self.app.link_exchange("public-sandbox-1", {"name": "Robinhood", "institution_id": "ins_54"})
        self.assertTrue(st["connected"])
        self.assertEqual(st["accounts"][0]["institution"], "Robinhood")
        self.assertNotIn("accessToken", st["accounts"][0])  # never sent to the browser
        mode = (Path(self.tmp.name) / "plaid.json").stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)
        p = self.app.sync()
        self.assertEqual(p["source"], "plaid")
        self.assertEqual(len(p["holdings"]), 2)
        self.assertEqual(len(p["dividends"]), 3)
        self.app.unlink("item-1")
        self.assertFalse(self.app.connected)
        self.assertIn("/item/remove", [c[0] for c in self.fake.calls])

    def test_login_required_flags_reconnect(self):
        self.app.link_exchange("public", {"name": "Robinhood"})
        self.fake.errors["/investments/holdings/get"] = "ITEM_LOGIN_REQUIRED"
        with self.assertRaises(ValueError):
            self.app.sync()
        self.assertTrue(self.app.status()["accounts"][0]["needsReauth"])
        del self.fake.errors["/investments/holdings/get"]
        self.app.link_repaired("item-1")
        self.assertFalse(self.app.status()["accounts"][0]["needsReauth"])

    def test_history_loading_schedules_retry(self):
        self.app.link_exchange("public", {"name": "Robinhood"})
        self.fake.errors["/investments/transactions/get"] = "PRODUCT_NOT_READY"
        self.app.sync()
        self.assertIn("still gathering", self.app.status()["lastError"])
        self.assertIsNotNone(self.app.state["retryAt"])


if __name__ == "__main__":
    unittest.main()
