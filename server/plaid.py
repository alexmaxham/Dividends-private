"""Plaid client for the dividend tracker: Link tokens, token exchange, and investment holdings + dividends.

People connect Robinhood (or any brokerage Plaid supports) through Plaid Link. They sign in on Plaid's and
their broker's own screens; this server only ever sees Plaid's access token, never a password.
Standard library only.

Needs PLAID_CLIENT_ID and PLAID_SECRET from https://dashboard.plaid.com (Developers → Keys), and
PLAID_ENV = sandbox | production.
"""

from __future__ import annotations

import datetime as dt
import json
import os
from typing import Any, Callable

from robinhood import Transport, urllib_transport

HOSTS = {"sandbox": "https://sandbox.plaid.com", "production": "https://production.plaid.com"}
# Cash dividends. "dividend reinvestment" is the matching buy of new shares, not extra income.
DIVIDEND_SUBTYPES = {"dividend", "qualified dividend", "non-qualified dividend"}
HISTORY_DAYS = 730  # Plaid returns up to 24 months; older payments are kept from earlier syncs.


class PlaidError(Exception):
    def __init__(self, message: str, code: str | None = None, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


class Plaid:
    def __init__(self, client_id: str, secret: str, env: str = "sandbox", transport: Transport = urllib_transport,
                 redirect_uri: str | None = None):
        if env not in HOSTS:
            raise ValueError(f"PLAID_ENV must be one of {', '.join(HOSTS)}")
        self.client_id, self.secret, self.env = client_id, secret, env
        self.base = HOSTS[env]
        self.transport = transport
        self.redirect_uri = redirect_uri

    @classmethod
    def from_env(cls) -> "Plaid | None":
        cid, secret = os.environ.get("PLAID_CLIENT_ID"), os.environ.get("PLAID_SECRET")
        if not (cid and secret):
            return None
        return cls(cid, secret, os.environ.get("PLAID_ENV", "sandbox"), redirect_uri=os.environ.get("PLAID_REDIRECT_URI"))

    def call(self, path: str, body: dict) -> dict:
        payload = json.dumps({"client_id": self.client_id, "secret": self.secret, **body}).encode()
        status, raw = self.transport("POST", self.base + path, {"Content-Type": "application/json"}, payload)
        try:
            data = json.loads(raw) if raw else {}
        except ValueError:
            raise PlaidError(f"Plaid returned an unreadable response (HTTP {status})", status=status)
        if status >= 400 or data.get("error_code"):
            msg = data.get("display_message") or data.get("error_message") or f"Plaid returned HTTP {status}"
            raise PlaidError(msg, data.get("error_code"), status)
        return data

    # ───────────── Link ─────────────

    def link_token(self, user_id: str, access_token: str | None = None) -> str:
        """A token for Plaid Link. With access_token, Link opens in update mode to repair a broken login."""
        body: dict[str, Any] = {
            "client_name": "Dividends",
            "language": "en",
            "country_codes": ["US"],
            "user": {"client_user_id": user_id},
        }
        if access_token:
            body["access_token"] = access_token
        else:
            body["products"] = ["investments"]
        if self.redirect_uri:
            body["redirect_uri"] = self.redirect_uri
        return self.call("/link/token/create", body)["link_token"]

    def exchange(self, public_token: str) -> dict:
        data = self.call("/item/public_token/exchange", {"public_token": public_token})
        return {"access_token": data["access_token"], "item_id": data["item_id"]}

    def remove(self, access_token: str) -> None:
        self.call("/item/remove", {"access_token": access_token})

    # ───────────── Data ─────────────

    def investment_transactions(self, access_token: str, today: dt.date) -> dict:
        start = (today - dt.timedelta(days=HISTORY_DAYS)).isoformat()
        out: dict[str, Any] = {"investment_transactions": [], "securities": {}}
        offset = 0
        while True:
            page = self.call("/investments/transactions/get", {
                "access_token": access_token, "start_date": start, "end_date": today.isoformat(),
                "options": {"count": 500, "offset": offset},
            })
            out["investment_transactions"].extend(page.get("investment_transactions") or [])
            for s in page.get("securities") or []:
                out["securities"][s["security_id"]] = s
            offset = len(out["investment_transactions"])
            if offset >= (page.get("total_investment_transactions") or 0) or not page.get("investment_transactions"):
                return out

    def fetch_item(self, access_token: str, item_id: str, today: dt.date) -> dict[str, Any]:
        """Holdings, cash dividends and cash for one linked login, in the web app's shape.

        Plaid has no per-share dividend rate or announced (future) dividends, so each payment's share count is
        rebuilt from the buys and sells after it, and the rate is the amount over those shares.
        """
        h = self.call("/investments/holdings/get", {"access_token": access_token})
        securities = {s["security_id"]: s for s in h.get("securities") or []}
        accounts = {a["account_id"]: a for a in h.get("accounts") or [] if a.get("type") == "investment"}

        holdings: dict[str, dict] = {}
        cash = 0.0
        qty_by_security: dict[str, float] = {}
        for x in h.get("holdings") or []:
            if x.get("account_id") not in accounts:
                continue
            sec = securities.get(x["security_id"], {})
            qty = _num(x.get("quantity"))
            if sec.get("is_cash_equivalent") or sec.get("type") == "cash":
                cash += _num(x.get("institution_value")) or qty
                continue
            if sec.get("type") == "derivative" or qty <= 0:
                continue
            symbol = (sec.get("ticker_symbol") or sec.get("name") or "?").upper()
            qty_by_security[x["security_id"]] = qty_by_security.get(x["security_id"], 0) + qty
            price = _num(x.get("institution_price")) or _num(sec.get("close_price"))
            cur = holdings.setdefault(symbol, {
                "symbol": symbol, "name": sec.get("name") or symbol, "shares": 0.0, "costBasis": 0.0, "price": price,
                "sector": sec.get("sector") or _sector_for_type(sec.get("type")), "industry": sec.get("industry") or "",
            })
            cur["shares"] += qty
            cost = x.get("cost_basis")
            cur["costBasis"] += _num(cost) if cost is not None else qty * price

        try:
            tx = self.investment_transactions(access_token, today)
            history_ready = True
        except PlaidError as e:
            if e.code != "PRODUCT_NOT_READY":
                raise
            tx, history_ready = {"investment_transactions": [], "securities": {}}, False
        securities.update(tx["securities"])

        trades = [t for t in tx["investment_transactions"] if t.get("type") in ("buy", "sell") and t.get("security_id")]
        dividends = []
        for t in tx["investment_transactions"]:
            if t.get("account_id") not in accounts or (t.get("subtype") or "").lower() not in DIVIDEND_SUBTYPES:
                continue
            sec = securities.get(t.get("security_id") or "", {})
            symbol = (sec.get("ticker_symbol") or sec.get("name") or _symbol_from_name(t.get("name")) or "?").upper()
            amount = abs(_num(t.get("amount")))
            if amount <= 0:
                continue
            shares = _shares_on(t.get("security_id"), t["date"], qty_by_security, trades)
            dividends.append({
                "id": f"plaid-{t['investment_transaction_id']}",
                "symbol": symbol,
                "amount": round(amount, 2),
                "rate": round(amount / shares, 6) if shares > 0 else 0,
                "shares": round(shares, 6),
                "state": "paid",
                "payDate": t["date"],
            })

        out = []
        for sym, x in sorted(holdings.items()):
            out.append({
                "symbol": sym, "name": x["name"], "shares": round(x["shares"], 6),
                "avgCost": round(x["costBasis"] / x["shares"], 4) if x["shares"] else 0,
                "price": x["price"], "prevClose": x["price"], "dividendYield": 0,
                "sector": x["sector"], "industry": x["industry"],
            })
        return {"holdings": out, "dividends": dividends, "cash": round(cash, 2), "historyReady": history_ready,
                "institution": (h.get("item") or {}).get("institution_id"), "itemId": item_id}


def merge_portfolios(parts: list[dict], previous: dict | None, today: str) -> dict:
    """Combine linked logins, keep dividends older than Plaid's 24-month window, and carry yesterday's price
    forward as previous close so the day's change still works (Plaid only reports the latest price)."""
    by_symbol: dict[str, dict] = {}
    for p in parts:
        for h in p["holdings"]:
            cur = by_symbol.get(h["symbol"])
            if cur is None:
                by_symbol[h["symbol"]] = dict(h)
            else:
                cost = cur["avgCost"] * cur["shares"] + h["avgCost"] * h["shares"]
                cur["shares"] += h["shares"]
                cur["avgCost"] = round(cost / cur["shares"], 4) if cur["shares"] else 0
    prev = previous or {}
    prev_holdings = {h["symbol"]: h for h in prev.get("holdings", [])}
    same_day = (prev.get("syncedAt") or "")[:10] == today
    for sym, h in by_symbol.items():
        p = prev_holdings.get(sym)
        if p:
            h["prevClose"] = p.get("prevClose", p["price"]) if same_day else p["price"]

    fresh = {d["id"]: d for p in parts for d in p["dividends"]}
    oldest_fresh = min((d["payDate"] for d in fresh.values()), default=today)
    kept = [d for d in prev.get("dividends", []) if d["id"] not in fresh and d["payDate"] < oldest_fresh]
    dividends = sorted([*fresh.values(), *kept], key=lambda d: d["payDate"], reverse=True)
    return {
        "holdings": sorted(by_symbol.values(), key=lambda h: h["symbol"]),
        "dividends": dividends,
        "cash": round(sum(p["cash"] for p in parts), 2),
    }


def _shares_on(security_id: str | None, date: str, current: dict[str, float], trades: list[dict]) -> float:
    """Shares held on `date`: today's count minus buys after it, plus sells after it (sell quantities are negative)."""
    if not security_id:
        return 0.0
    q = current.get(security_id, 0.0)
    for t in trades:
        if t["security_id"] == security_id and t["date"] > date:
            q -= _num(t.get("quantity"))
    return max(q, 0.0)


def _symbol_from_name(name: str | None) -> str | None:
    # e.g. "Dividend: KO" / "CASH DIV KO" — last all-caps word as a fallback when Plaid gives no security.
    for word in reversed((name or "").replace(":", " ").split()):
        if word.isalpha() and word.isupper() and 1 <= len(word) <= 5 and word not in {"DIV", "CASH", "QUAL"}:
            return word
    return None


def _sector_for_type(kind: str | None) -> str:
    return {"etf": "ETF", "mutual fund": "Mutual fund", "cryptocurrency": "Crypto", "fixed income": "Bonds"}.get(kind or "", "Other")


def _num(v: Any) -> float:
    try:
        return float(v) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0
