"""Offline tests for the Robinhood client and sync: a fake transport stands in for api.robinhood.com.

    python3 -m unittest discover -s server
"""

import datetime as dt
import json
import tempfile
import unittest
import urllib.parse
from pathlib import Path

from robinhood import API, Client, RobinhoodError
from server import App, Store

INST_KO = f"{API}/instruments/ko/"
INST_O = f"{API}/instruments/o/"
INST_SOLD = f"{API}/instruments/sold/"


class FakeRobinhood:
    def __init__(self, routes):
        self.routes = routes  # {(method, path): handler(body) -> (status, json)}
        self.calls = []

    def __call__(self, method, url, headers, body):
        path = url.removeprefix(API)
        self.calls.append((method, path, headers, body))
        handler = self.routes.get((method, path))
        if handler is None:
            return 404, b'{"detail": "not found"}'
        status, value = handler(body)
        return status, json.dumps(value).encode()


def form(body):
    return dict(urllib.parse.parse_qsl(body.decode()))


def portfolio_routes():
    return {
        ("GET", "/accounts/"): lambda b: (200, {"results": [{"portfolio_cash": "120.50"}]}),
        ("GET", "/positions/?nonzero=true"): lambda b: (200, {
            "results": [
                {"instrument": INST_KO, "quantity": "10.0000", "average_buy_price": "55.00"},
                {"instrument": INST_O, "quantity": "20.5", "average_buy_price": "56.00"},
            ],
            "next": f"{API}/positions/?cursor=2",
        }),
        ("GET", "/positions/?cursor=2"): lambda b: (200, {"results": [
            {"instrument": INST_O, "quantity": "0.0000", "average_buy_price": "0"},
        ], "next": None}),
        ("GET", "/instruments/ko/"): lambda b: (200, {"symbol": "KO", "simple_name": "Coca-Cola"}),
        ("GET", "/instruments/o/"): lambda b: (200, {"symbol": "O", "simple_name": "Realty Income"}),
        ("GET", "/instruments/sold/"): lambda b: (200, {"symbol": "T", "simple_name": "AT&T"}),
        ("GET", "/marketdata/quotes/?symbols=KO,O"): lambda b: (200, {"results": [
            {"symbol": "KO", "last_trade_price": "70.00", "previous_close": "69.00"},
            {"symbol": "O", "last_trade_price": "57.00", "last_extended_hours_trade_price": "57.50", "previous_close": "57.20"},
        ]}),
        ("GET", "/fundamentals/?symbols=KO,O"): lambda b: (200, {"results": [
            {"symbol": "KO", "dividend_yield": "2.90", "sector": "Consumer Non-Durables"},
            {"symbol": "O", "dividend_yield": "5.60", "sector": "Finance"},
        ]}),
        ("GET", "/dividends/"): lambda b: (200, {"results": [
            {"id": "d1", "instrument": INST_KO, "amount": "5.10", "rate": "0.51", "position": "10", "state": "paid",
             "payable_date": "2026-07-01", "record_date": "2026-06-13", "withholding": "0.00", "drip_enabled": False},
            {"id": "d2", "instrument": INST_SOLD, "amount": "2.78", "rate": "0.2775", "position": "10", "state": "paid",
             "payable_date": "2025-02-03", "record_date": "2025-01-10", "withholding": "0"},
            {"id": "d3", "instrument": INST_O, "amount": "5.52", "rate": "0.269", "position": "20.5", "state": "pending",
             "payable_date": "2026-11-14", "record_date": "2026-10-31", "drip_enabled": True},
        ], "next": None}),
    }


class ClientTests(unittest.TestCase):
    def test_password_login_stores_tokens(self):
        saved = []
        fake = FakeRobinhood({("POST", "/oauth2/token/"): lambda b: (200, {
            "access_token": "AT", "refresh_token": "RT", "expires_in": 734000})})
        c = Client(transport=fake, on_session_change=lambda s: saved.append(dict(s)))
        self.assertEqual(c.login("me@example.com", "pw"), {"status": "ok"})
        self.assertTrue(c.connected)
        self.assertEqual(saved[-1]["refresh_token"], "RT")
        self.assertNotIn("password", saved[-1])
        sent = form(fake.calls[0][3])
        self.assertEqual(sent["grant_type"], "password")
        self.assertEqual(sent["device_token"], c.session["device_token"])

    def test_mfa_then_success(self):
        def token(b):
            f = form(b)
            if f.get("mfa_code") != "123456":
                return 400, {"mfa_required": True, "mfa_type": "app"}
            return 200, {"access_token": "AT", "refresh_token": "RT", "expires_in": 100}
        c = Client(transport=FakeRobinhood({("POST", "/oauth2/token/"): token}))
        self.assertEqual(c.login("me", "pw"), {"status": "mfa_required"})
        with self.assertRaises(RobinhoodError):
            c.submit_challenge("000000")
        self.assertEqual(c.submit_challenge("123456"), {"status": "ok"})

    def test_sms_verification_workflow(self):
        state = {"approved": False}

        def token(b):
            if state["approved"]:
                return 200, {"access_token": "AT", "refresh_token": "RT", "expires_in": 100}
            return 403, {"verification_workflow": {"id": "wf1", "workflow_status": "workflow_status_internal_pending"}}

        def respond(b):
            ok = form(b)["response"] == "4242"
            return 200, {"status": "validated" if ok else "issued"}

        def approve(b):
            state["approved"] = True
            return 200, {"type_context": {"result": "workflow_status_approved"}}

        fake = FakeRobinhood({
            ("POST", "/oauth2/token/"): token,
            ("POST", "/pathfinder/user_machine/"): lambda b: (200, {"id": "m1"}),
            ("GET", "/pathfinder/inquiries/m1/user_view/"): lambda b: (200, {
                "context": {"sheriff_challenge": {"id": "c1", "type": "sms", "status": "issued"}}}),
            ("POST", "/challenge/c1/respond/"): respond,
            ("POST", "/pathfinder/inquiries/m1/user_view/"): approve,
        })
        c = Client(transport=fake)
        self.assertEqual(c.login("me", "pw"), {"status": "challenge", "type": "sms"})
        with self.assertRaises(RobinhoodError):
            c.submit_challenge("1111")
        self.assertEqual(c.submit_challenge("4242"), {"status": "ok"})
        self.assertEqual(c.session["access_token"], "AT")

    def test_app_prompt_waits_until_approved(self):
        state = {"validated": False}
        fake = FakeRobinhood({
            ("POST", "/oauth2/token/"): lambda b: (200, {"access_token": "AT", "expires_in": 100}) if state["validated"]
            else (403, {"verification_workflow": {"id": "wf"}}),
            ("POST", "/pathfinder/user_machine/"): lambda b: (200, {"id": "m"}),
            ("GET", "/pathfinder/inquiries/m/user_view/"): lambda b: (200, {
                "context": {"sheriff_challenge": {"id": "c", "type": "prompt", "status": "issued"}}}),
            ("GET", "/push/c/get_prompts_status/"): lambda b: (200, {
                "challenge_status": "validated" if state["validated"] else "issued"}),
            ("POST", "/pathfinder/inquiries/m/user_view/"): lambda b: (200, {
                "type_context": {"result": "workflow_status_approved"}}),
        })
        c = Client(transport=fake)
        self.assertEqual(c.login("me", "pw")["type"], "prompt")
        self.assertTrue(c.submit_challenge()["waiting"])
        state["validated"] = True
        self.assertEqual(c.submit_challenge(), {"status": "ok"})

    def test_expired_token_refreshes_and_retries(self):
        tokens = {"current": "OLD"}

        def accounts(b):
            return (200, {"results": []}) if tokens["current"] == "NEW" else (401, {"detail": "expired"})

        def token(b):
            self.assertEqual(form(b)["grant_type"], "refresh_token")
            tokens["current"] = "NEW"
            return 200, {"access_token": "NEW", "refresh_token": "RT2", "expires_in": 734000}

        fake = FakeRobinhood({("GET", "/accounts/"): accounts, ("POST", "/oauth2/token/"): token})
        import time
        c = Client({"access_token": "OLD", "refresh_token": "RT", "expires_at": time.time() + 7 * 86400}, transport=fake)
        self.assertEqual(c.get("/accounts/"), {"results": []})
        self.assertEqual(c.session["refresh_token"], "RT2")

    def test_fetch_portfolio_normalizes(self):
        import time
        c = Client({"access_token": "AT", "refresh_token": "RT", "expires_at": time.time() + 7 * 86400},
                   transport=FakeRobinhood(portfolio_routes()))
        p = c.fetch_portfolio({})
        self.assertEqual(p["cash"], 120.5)
        self.assertEqual([h["symbol"] for h in p["holdings"]], ["KO", "O"])
        o = p["holdings"][1]
        self.assertEqual((o["shares"], o["avgCost"], o["price"], o["dividendYield"]), (20.5, 56.0, 57.5, 5.6))
        self.assertEqual([d["payDate"] for d in p["dividends"]], ["2026-11-14", "2026-07-01", "2025-02-03"])
        self.assertEqual(p["dividends"][2]["symbol"], "T")  # sold positions keep their history
        self.assertTrue(p["dividends"][0]["drip"])


class AppTests(unittest.TestCase):
    def setUp(self):
        import time
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name))
        client = Client({"access_token": "AT", "refresh_token": "RT", "expires_at": time.time() + 7 * 86400},
                        transport=FakeRobinhood(portfolio_routes()))
        self.app = App(self.store, client)

    def tearDown(self):
        self.tmp.cleanup()

    def test_sync_writes_portfolio_and_history(self):
        p = self.app.sync()
        self.assertEqual(p["source"], "robinhood")
        self.assertEqual(len(p["history"]), 1)
        self.assertAlmostEqual(p["history"][0]["value"], 10 * 70 + 20.5 * 57.5, places=2)
        self.app.sync()  # same day replaces, doesn't append
        self.assertEqual(len(self.store.read("portfolio.json", {})["history"]), 1)
        self.assertIsNotNone(self.app.status()["lastSync"])

    def test_session_file_is_private(self):
        self.app.client.on_session_change = self.app._save_session
        self.app._save_session(self.app.client.session)
        mode = (Path(self.tmp.name) / "session.json").stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_due_after_daily_slot_once(self):
        self.app.settings["syncTime"] = "18:30"
        local = dt.datetime.now().astimezone().tzinfo
        before = dt.datetime(2026, 10, 21, 9, 0, tzinfo=local)
        after = dt.datetime(2026, 10, 21, 19, 0, tzinfo=local)
        self.app.state["lastSync"] = dt.datetime(2026, 10, 20, 19, 0, tzinfo=local).isoformat()
        self.assertFalse(self.app.due(before))
        self.assertTrue(self.app.due(after))
        self.app.state["lastSync"] = dt.datetime(2026, 10, 21, 18, 31, tzinfo=local).isoformat()
        self.assertFalse(self.app.due(after))

    def test_due_catches_up_when_stale(self):
        local = dt.datetime.now().astimezone().tzinfo
        self.app.state["lastSync"] = dt.datetime(2026, 10, 18, 19, 0, tzinfo=local).isoformat()
        self.assertTrue(self.app.due(dt.datetime(2026, 10, 21, 9, 0, tzinfo=local)))

    def test_settings_validation(self):
        with self.assertRaises(ValueError):
            self.app.update_settings({"syncTime": "25:99"})
        self.assertEqual(self.app.update_settings({"syncTime": "07:15"})["settings"]["syncTime"], "07:15")


if __name__ == "__main__":
    unittest.main()
