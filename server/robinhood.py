"""Minimal Robinhood client: sign-in (with MFA / device verification), token refresh, and the reads
the dividend tracker needs. Standard library only.

Robinhood has no official public API for brokerage accounts. This uses the same endpoints as the
Robinhood web app, the ones the open-source robin_stocks project documents, so it can break whenever
Robinhood changes them. Everything here is read-only: nothing places orders or moves money.
"""

from __future__ import annotations

import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

API = "https://api.robinhood.com"
CLIENT_ID = "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS"
TOKEN_LIFETIME = 734000  # seconds (~8.5 days), what the web app asks for
HEADERS = {
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=1",
    "X-Robinhood-API-Version": "1.431.4",
    "User-Agent": "dividend-tracker/1.0",
}


class RobinhoodError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def new_device_token() -> str:
    """Random device id in Robinhood's 8-4-4-4-12 hex layout. Reusing one keeps the device trusted."""
    h = secrets.token_hex(16)
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


Transport = Callable[[str, str, dict[str, str], bytes | None], tuple[int, bytes]]


def urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class Client:
    def __init__(self, session: dict[str, Any] | None = None, transport: Transport = urllib_transport,
                 on_session_change: Callable[[dict[str, Any]], None] | None = None):
        # session: {access_token, refresh_token, expires_at, device_token, username}
        self.session: dict[str, Any] = session or {}
        self.session.setdefault("device_token", new_device_token())
        self.transport = transport
        self.on_session_change = on_session_change
        self._pending: dict[str, Any] | None = None  # sign-in waiting on MFA or verification

    # ───────────── HTTP ─────────────

    def _request(self, method: str, url: str, form: dict | None = None, body_json: dict | None = None,
                 auth: bool = True) -> Any:
        if not url.startswith("http"):
            url = API + url
        headers = dict(HEADERS)
        body = None
        if form is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8"
            body = urllib.parse.urlencode(form).encode()
        elif body_json is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(body_json).encode()
        if auth and self.session.get("access_token"):
            headers["Authorization"] = f"Bearer {self.session['access_token']}"
        status, raw = self.transport(method, url, headers, body)
        try:
            data = json.loads(raw) if raw else {}
        except ValueError:
            data = {"detail": raw[:200].decode("utf-8", "replace")}
        if status >= 400 and not (isinstance(data, dict) and _is_login_step(data)):
            detail = data.get("detail") or data.get("error_description") or data.get("error") if isinstance(data, dict) else None
            raise RobinhoodError(str(detail or f"Robinhood returned HTTP {status}"), status)
        return data

    def get(self, url: str) -> Any:
        """Authenticated GET that refreshes an expired token once and retries."""
        self.ensure_fresh()
        try:
            return self._request("GET", url)
        except RobinhoodError as e:
            if e.status == 401 and self.session.get("refresh_token"):
                self.refresh()
                return self._request("GET", url)
            raise

    def paginate(self, url: str, limit: int = 200) -> list[dict]:
        out: list[dict] = []
        next_url: str | None = url
        while next_url and limit > 0:
            data = self.get(next_url)
            out.extend(data.get("results") or [])
            next_url = data.get("next")
            limit -= 1
        return out

    # ───────────── Sign-in ─────────────

    @property
    def connected(self) -> bool:
        return bool(self.session.get("access_token"))

    def _token_payload(self, username: str, password: str) -> dict[str, Any]:
        return {
            "client_id": CLIENT_ID,
            "expires_in": TOKEN_LIFETIME,
            "grant_type": "password",
            "password": password,
            "scope": "internal",
            "username": username,
            "device_token": self.session["device_token"],
            "try_passkeys": "false",
            "token_request_path": "/login",
            "create_read_only_secondary_token": "true",
        }

    def login(self, username: str, password: str, mfa_code: str | None = None) -> dict[str, Any]:
        """Start (or finish, with mfa_code) a sign-in.

        Returns {"status": "ok"}, {"status": "mfa_required"} for an authenticator-app code, or
        {"status": "challenge", "type": "sms"|"email"|"prompt"} when Robinhood wants the device verified.
        The password is only held in memory until the sign-in completes.
        """
        payload = self._token_payload(username, password)
        if mfa_code:
            payload["mfa_code"] = mfa_code.strip()
        data = self._request("POST", "/oauth2/token/", form=payload, auth=False)
        if data.get("mfa_required"):
            self._pending = {"payload": payload, "username": username, "stage": "mfa"}
            return {"status": "mfa_required"}
        if "verification_workflow" in data:
            self._pending = {"payload": payload, "username": username}
            return self._start_verification(data["verification_workflow"]["id"])
        return self._finish(data, username)

    def submit_mfa(self, code: str) -> dict[str, Any]:
        p = self._require_pending()
        p["payload"]["mfa_code"] = code.strip()
        data = self._request("POST", "/oauth2/token/", form=p["payload"], auth=False)
        if data.get("mfa_required"):
            raise RobinhoodError("That code didn't work. Try the newest one from your authenticator app.")
        if "verification_workflow" in data:
            return self._start_verification(data["verification_workflow"]["id"])
        return self._finish(data, p["username"])

    def _start_verification(self, workflow_id: str) -> dict[str, Any]:
        p = self._require_pending()
        machine = self._request("POST", "/pathfinder/user_machine/", auth=False, body_json={
            "device_id": self.session["device_token"], "flow": "suv", "input": {"workflow_id": workflow_id},
        })
        inquiry = f"{API}/pathfinder/inquiries/{machine['id']}/user_view/"
        view = self._request("GET", inquiry, auth=False)
        challenge = view["context"]["sheriff_challenge"]
        p.update(stage="challenge", inquiry=inquiry, challenge_id=challenge["id"], challenge_type=challenge["type"])
        return {"status": "challenge", "type": challenge["type"]}

    def submit_challenge(self, code: str | None = None) -> dict[str, Any]:
        """Answer an SMS/email code, or (with no code) check whether an app prompt was approved."""
        p = self._require_pending()
        if p.get("stage") == "mfa":
            if not code:
                raise RobinhoodError("Enter the code from your authenticator app.")
            return self.submit_mfa(code)
        cid = p["challenge_id"]
        if p["challenge_type"] == "prompt":
            status = self._request("GET", f"/push/{cid}/get_prompts_status/", auth=False)
            if status.get("challenge_status") != "validated":
                return {"status": "challenge", "type": "prompt", "waiting": True}
        else:
            if not code:
                raise RobinhoodError("Enter the code Robinhood sent you.")
            res = self._request("POST", f"/challenge/{cid}/respond/", form={"response": code.strip()}, auth=False)
            if res.get("status") != "validated":
                raise RobinhoodError("That code didn't work. Check it and try again.")
        done = self._request("POST", p["inquiry"], auth=False,
                             body_json={"sequence": 0, "user_input": {"status": "continue"}})
        result = (done.get("type_context") or {}).get("result")
        if result != "workflow_status_approved":
            raise RobinhoodError("Robinhood didn't approve this device. Start the sign-in again.")
        data = self._request("POST", "/oauth2/token/", form=p["payload"], auth=False)
        if data.get("mfa_required"):
            p["stage"] = "mfa"
            return {"status": "mfa_required"}
        return self._finish(data, p["username"])

    def _require_pending(self) -> dict[str, Any]:
        if not self._pending:
            raise RobinhoodError("No sign-in in progress. Start again.")
        return self._pending

    def _finish(self, data: dict, username: str) -> dict[str, Any]:
        if "access_token" not in data:
            raise RobinhoodError(data.get("detail") or "Robinhood didn't return a session.")
        self._pending = None
        self._store_tokens(data, username)
        return {"status": "ok"}

    def _store_tokens(self, data: dict, username: str | None = None) -> None:
        self.session.update(
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token", self.session.get("refresh_token")),
            expires_at=time.time() + float(data.get("expires_in", TOKEN_LIFETIME)),
        )
        if username:
            self.session["username"] = username
        if self.on_session_change:
            self.on_session_change(self.session)

    def refresh(self) -> None:
        if not self.session.get("refresh_token"):
            raise RobinhoodError("Robinhood session expired. Sign in again.", 401)
        try:
            data = self._request("POST", "/oauth2/token/", auth=False, form={
                "grant_type": "refresh_token",
                "refresh_token": self.session["refresh_token"],
                "scope": "internal",
                "client_id": CLIENT_ID,
                "expires_in": TOKEN_LIFETIME,
                "device_token": self.session["device_token"],
            })
        except RobinhoodError as e:
            raise RobinhoodError("Robinhood session expired. Sign in again.", 401) from e
        self._store_tokens(data)

    def ensure_fresh(self) -> None:
        exp = self.session.get("expires_at") or 0
        if self.session.get("refresh_token") and exp - time.time() < 6 * 3600:
            self.refresh()

    def logout(self) -> None:
        token = self.session.get("access_token")
        if token:
            try:
                self._request("POST", "/oauth2/revoke_token/", auth=False,
                              form={"client_id": CLIENT_ID, "token": token})
            except (RobinhoodError, OSError):
                pass
        device = self.session.get("device_token")
        self.session = {"device_token": device}
        self._pending = None
        if self.on_session_change:
            self.on_session_change(self.session)

    # ───────────── Portfolio data ─────────────

    def fetch_portfolio(self, instrument_cache: dict[str, dict]) -> dict[str, Any]:
        """Holdings, dividends and cash, normalized to the shape the web app uses."""
        accounts = self.get("/accounts/").get("results") or []
        cash = _num(accounts[0].get("portfolio_cash")) if accounts else 0.0
        positions = [p for p in self.paginate("/positions/?nonzero=true") if _num(p.get("quantity")) > 0]
        dividends_raw = self.paginate("/dividends/")

        def instrument(url: str) -> dict:
            if url not in instrument_cache:
                inst = self.get(url)
                instrument_cache[url] = {"symbol": inst.get("symbol"), "name": inst.get("simple_name") or inst.get("name")}
            return instrument_cache[url]

        holdings_by_symbol: dict[str, dict] = {}
        for p in positions:
            inst = instrument(p["instrument"])
            sym = inst["symbol"]
            if not sym:
                continue
            h = holdings_by_symbol.setdefault(sym, {"symbol": sym, "name": inst["name"] or sym, "shares": 0.0, "costBasis": 0.0})
            qty = _num(p.get("quantity"))
            h["shares"] += qty
            h["costBasis"] += qty * _num(p.get("average_buy_price"))

        symbols = sorted(holdings_by_symbol)
        quotes, fundamentals = {}, {}
        for i in range(0, len(symbols), 50):
            chunk = ",".join(symbols[i:i + 50])
            for q in self.get(f"/marketdata/quotes/?symbols={chunk}").get("results") or []:
                if q:
                    quotes[q["symbol"]] = q
            for f in self.get(f"/fundamentals/?symbols={chunk}").get("results") or []:
                if f and f.get("symbol"):
                    fundamentals[f["symbol"]] = f

        holdings = []
        for sym in symbols:
            h = holdings_by_symbol[sym]
            q, f = quotes.get(sym, {}), fundamentals.get(sym, {})
            price = _num(q.get("last_extended_hours_trade_price")) or _num(q.get("last_trade_price"))
            holdings.append({
                "symbol": sym,
                "name": h["name"],
                "shares": round(h["shares"], 6),
                "avgCost": round(h["costBasis"] / h["shares"], 4) if h["shares"] else 0,
                "price": price,
                "prevClose": _num(q.get("adjusted_previous_close")) or _num(q.get("previous_close")) or price,
                "dividendYield": _num(f.get("dividend_yield")),
                "sector": f.get("sector") or "Other",
                "industry": f.get("industry") or "",
            })

        dividends = []
        for d in dividends_raw:
            inst = instrument(d["instrument"])
            dividends.append({
                "id": d.get("id"),
                "symbol": inst["symbol"] or "?",
                "amount": _num(d.get("amount")),
                "rate": _num(d.get("rate")),
                "shares": _num(d.get("position")),
                "withholding": _num(d.get("withholding")) + _num(d.get("nra_withholding")),
                "state": d.get("state") or "pending",
                "payDate": (d.get("payable_date") or "")[:10],
                "recordDate": (d.get("record_date") or "")[:10],
                "drip": bool(d.get("drip_enabled")),
            })
        dividends.sort(key=lambda x: x["payDate"], reverse=True)
        return {"holdings": holdings, "dividends": dividends, "cash": cash}


def _is_login_step(data: dict) -> bool:
    return bool(data.get("mfa_required") or data.get("verification_workflow"))


def _num(v: Any) -> float:
    try:
        return float(v) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0
