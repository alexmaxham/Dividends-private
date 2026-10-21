"""Dividend tracker server: serves the web app, keeps brokerage connections, and syncs once a day.

    PLAID_CLIENT_ID=... PLAID_SECRET=... python3 server/server.py      # http://127.0.0.1:8787

Accounts connect through Plaid Link, so people sign in on Plaid's and Robinhood's own screens and this server
only keeps Plaid's access token. Without Plaid keys it falls back to signing in to Robinhood directly.

Environment:
    PLAID_CLIENT_ID     from dashboard.plaid.com → Developers → Keys
    PLAID_SECRET        the secret for PLAID_ENV
    PLAID_ENV           sandbox (default, test logins only) or production
    PLAID_REDIRECT_URI  optional; an https URL registered with Plaid, needed for OAuth sign-in on phones
    PORT                default 8787
    HOST                default 127.0.0.1 (only this computer). Use 0.0.0.0 to reach it from your phone,
                        and set APP_TOKEN when you do.
    APP_TOKEN           if set, every /api call must send "Authorization: Bearer <APP_TOKEN>"
    DATA_DIR            where the session and portfolio are saved (default: dividends/data)
    TZ                  the time zone the daily sync time is read in (default: the machine's)
"""

from __future__ import annotations

import datetime as dt
import hmac
import json
import mimetypes
import os
import secrets
import sys
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from plaid import Plaid, PlaidError, merge_portfolios  # noqa: E402
from robinhood import Client, RobinhoodError  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
APP_TOKEN = os.environ.get("APP_TOKEN", "")
HISTORY_DAYS = 3 * 365


class Store:
    """JSON files in DATA_DIR. Files with access tokens (plaid.json, session.json) are readable by their owner only."""

    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def read(self, name: str, default: Any) -> Any:
        try:
            return json.loads((self.dir / name).read_text())
        except (FileNotFoundError, ValueError):
            return default

    def write(self, name: str, value: Any, private: bool = False) -> None:
        with self.lock:
            tmp = self.dir / f".{name}.tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600 if private else 0o644)
            with os.fdopen(fd, "w") as f:
                json.dump(value, f, indent=1)
            os.replace(tmp, self.dir / name)


class App:
    def __init__(self, store: Store, client: Client | None = None, plaid: Plaid | None = None, use_env: bool = True):
        self.store = store
        self.settings = {"syncTime": "18:30", "autoSync": True, **store.read("settings.json", {})}
        self.state = store.read("state.json", {"lastSync": None, "lastError": None, "instruments": {}})
        self.plaid = plaid or (Plaid.from_env() if use_env else None)
        self.links = store.read("plaid.json", {"userId": secrets.token_hex(8), "items": []})
        self.client = client or Client(store.read("session.json", None), on_session_change=self._save_session)
        self.sync_lock = threading.Lock()
        self.syncing = False

    @property
    def provider(self) -> str:
        return "plaid" if self.plaid else "robinhood"

    @property
    def connected(self) -> bool:
        return bool(self.links["items"]) if self.plaid else self.client.connected

    def _save_links(self) -> None:
        self.store.write("plaid.json", self.links, private=True)

    def _item(self, item_id: str) -> dict:
        for it in self.links["items"]:
            if it["itemId"] == item_id:
                return it
        raise ValueError("That account isn't linked.")

    # ───────────── Plaid Link ─────────────

    def _require_plaid(self) -> Plaid:
        if not self.plaid:
            raise ValueError("Plaid isn't set up on this server. Start it with PLAID_CLIENT_ID and PLAID_SECRET.")
        return self.plaid

    def link_token(self, item_id: str | None = None) -> dict:
        plaid = self._require_plaid()
        access = self._item(item_id)["accessToken"] if item_id else None
        return {"linkToken": plaid.link_token(self.links["userId"], access)}

    def link_exchange(self, public_token: str, institution: dict | None) -> dict:
        plaid = self._require_plaid()
        tokens = plaid.exchange(public_token)
        inst = institution or {}
        self.links["items"].append({
            "itemId": tokens["item_id"], "accessToken": tokens["access_token"],
            "institution": inst.get("name") or "Brokerage", "institutionId": inst.get("institution_id") or inst.get("id"),
            "linkedAt": dt.datetime.now().astimezone().isoformat(), "needsReauth": False,
        })
        self._save_links()
        return self.status()

    def link_repaired(self, item_id: str) -> dict:
        self._item(item_id)["needsReauth"] = False
        self._save_links()
        return self.status()

    def unlink(self, item_id: str) -> dict:
        item = self._item(item_id)
        try:
            self._require_plaid().remove(item["accessToken"])
        except (PlaidError, OSError) as e:  # still forget it locally; the user asked to disconnect
            log(f"Plaid item/remove failed: {e}")
        self.links["items"] = [it for it in self.links["items"] if it["itemId"] != item_id]
        self._save_links()
        return self.status()

    def disconnect(self) -> dict:
        if self.plaid:
            for it in list(self.links["items"]):
                self.unlink(it["itemId"])
        else:
            self.client.logout()
        return self.status()

    def _save_session(self, session: dict) -> None:
        self.store.write("session.json", session, private=True)

    def _save_state(self) -> None:
        self.store.write("state.json", self.state)

    # ───────────── Status & settings ─────────────

    def next_sync(self, now: dt.datetime | None = None) -> str | None:
        if not (self.connected and self.settings["autoSync"]):
            return None
        now = now or dt.datetime.now()
        hh, mm = (int(x) for x in self.settings["syncTime"].split(":"))
        at = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if self._synced_today(now):
            at += dt.timedelta(days=1)
        elif at <= now:
            at = now  # due: the scheduler picks it up within a minute
        return at.astimezone().isoformat()

    def _synced_today(self, now: dt.datetime) -> bool:
        last = self.state.get("lastSync")
        if not last:
            return False
        hh, mm = (int(x) for x in self.settings["syncTime"].split(":"))
        today_slot = now.replace(hour=hh, minute=mm, second=0, microsecond=0).astimezone()
        return dt.datetime.fromisoformat(last) >= today_slot

    def status(self) -> dict:
        return {
            "server": True,
            "provider": self.provider,
            "plaidEnv": self.plaid.env if self.plaid else None,
            "connected": self.connected,
            "username": None if self.plaid else self.client.session.get("username"),
            "accounts": [{k: it.get(k) for k in ("itemId", "institution", "linkedAt", "needsReauth")} for it in self.links["items"]]
            if self.plaid else [],
            "syncing": self.syncing,
            "lastSync": self.state.get("lastSync"),
            "lastError": self.state.get("lastError"),
            "nextSync": self.next_sync(),
            "settings": self.settings,
        }

    def update_settings(self, body: dict) -> dict:
        if "syncTime" in body:
            t = str(body["syncTime"])
            try:
                dt.time.fromisoformat(t)
            except ValueError:
                raise ValueError("syncTime must look like 18:30")
            self.settings["syncTime"] = t[:5]
        if "autoSync" in body:
            self.settings["autoSync"] = bool(body["autoSync"])
        self.store.write("settings.json", self.settings)
        return self.status()

    # ───────────── Sync ─────────────

    def due(self, now: dt.datetime | None = None) -> bool:
        now = now or dt.datetime.now()
        if not (self.connected and self.settings["autoSync"]) or self.syncing:
            return False
        retry = self.state.get("retryAt")
        if retry and now.astimezone() >= dt.datetime.fromisoformat(retry):
            return True
        hh, mm = (int(x) for x in self.settings["syncTime"].split(":"))
        slot = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if now >= slot:
            return not self._synced_today(now)
        # Before today's slot: still catch up if the last sync is more than a day old (machine was off).
        last = self.state.get("lastSync")
        return not last or (now.astimezone() - dt.datetime.fromisoformat(last)) > dt.timedelta(hours=26)

    def sync(self) -> dict:
        if not self.connected:
            raise ValueError("Connect your Robinhood account first.")
        if not self.sync_lock.acquire(blocking=False):
            raise ValueError("A sync is already running.")
        self.syncing = True
        try:
            previous = self.store.read("portfolio.json", {})
            now = dt.datetime.now().astimezone()
            note = None
            if self.plaid:
                data, note = self._fetch_plaid(previous, now.date())
            else:
                data = self.client.fetch_portfolio(self.state.setdefault("instruments", {}))
            value = sum(h["shares"] * h["price"] for h in data["holdings"])
            cost = sum(h["shares"] * h["avgCost"] for h in data["holdings"])
            history = [s for s in previous.get("history", []) if s["date"] != now.date().isoformat()]
            history.append({"date": now.date().isoformat(), "value": round(value, 2), "cost": round(cost, 2)})
            history = history[-HISTORY_DAYS:]
            portfolio = {**data, "history": history, "source": self.provider, "syncedAt": now.isoformat()}
            self.store.write("portfolio.json", portfolio, private=True)
            retry = (now + dt.timedelta(minutes=10)).isoformat() if note and "still" in note else None
            self.state.update(lastSync=now.isoformat(), lastError=note, retryAt=retry)
            self._save_state()
            return portfolio
        except Exception as e:
            self.state["lastError"] = str(e)
            self._save_state()
            if isinstance(e, RobinhoodError) and e.status == 401:
                self.client.session.pop("access_token", None)
                self._save_session(self.client.session)
            raise
        finally:
            self.syncing = False
            self.sync_lock.release()

    def _fetch_plaid(self, previous: dict, today: dt.date) -> tuple[dict, str | None]:
        parts, problems, loading = [], [], False
        for it in self.links["items"]:
            try:
                part = self.plaid.fetch_item(it["accessToken"], it["itemId"], today)
            except PlaidError as e:
                if e.code in ("ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT"):
                    it["needsReauth"] = True
                    self._save_links()
                    problems.append(f"{it['institution']} needs you to sign in again (Settings → Reconnect).")
                    continue
                raise
            loading = loading or not part["historyReady"]
            parts.append(part)
        if not parts:
            raise ValueError(" ".join(problems) or "No linked accounts returned data.")
        if loading:
            problems.append("Plaid is still gathering your dividend history; it'll appear on a sync in a few minutes.")
        return merge_portfolios(parts, previous, today.isoformat()), " ".join(problems) or None

    def scheduler(self, stop: threading.Event) -> None:
        while not stop.wait(30):
            if self.due():
                try:
                    self.sync()
                    log("daily sync finished")
                except Exception as e:  # recorded in state; retry next slot or after an hour
                    log(f"daily sync failed: {e}")
                    stop.wait(3600)


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = "DividendTracker/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:
            if not self.path.startswith("/api/status"):
                log(f"{self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}")

        def send_json(self, value: Any, status: int = 200) -> None:
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 1_000_000:
                raise ValueError("Request too large")
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def authorized(self) -> bool:
            if not APP_TOKEN:
                return True
            got = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
            return hmac.compare_digest(got, APP_TOKEN)

        def do_GET(self) -> None:
            if self.path.startswith("/api/"):
                return self.api("GET")
            self.static()

        def do_POST(self) -> None:
            self.api("POST")

        def do_PUT(self) -> None:
            self.api("PUT")

        def api(self, method: str) -> None:
            route = self.path.split("?")[0]
            if route == "/api/status" and method == "GET" and not self.authorized():
                return self.send_json({"server": True, "needsToken": True}, 401)
            if not self.authorized():
                return self.send_json({"error": "This server needs its access token (Settings → Server)."}, 401)
            try:
                if (method, route) == ("GET", "/api/status"):
                    return self.send_json(app.status())
                if (method, route) == ("GET", "/api/portfolio"):
                    return self.send_json(app.store.read("portfolio.json", None))
                if (method, route) == ("PUT", "/api/settings"):
                    return self.send_json(app.update_settings(self.body()))
                if (method, route) == ("POST", "/api/plaid/link-token"):
                    return self.send_json(app.link_token(self.body().get("itemId")))
                if (method, route) == ("POST", "/api/plaid/exchange"):
                    b = self.body()
                    if not b.get("publicToken"):
                        raise ValueError("Missing publicToken")
                    return self.send_json(app.link_exchange(b["publicToken"], b.get("institution")))
                if (method, route) == ("POST", "/api/plaid/repaired"):
                    return self.send_json(app.link_repaired(self.body().get("itemId", "")))
                if (method, route) == ("POST", "/api/plaid/remove"):
                    return self.send_json(app.unlink(self.body().get("itemId", "")))
                if route.startswith("/api/robinhood/") and route != "/api/robinhood/logout" and app.plaid:
                    raise ValueError("This server connects through Plaid; direct Robinhood sign-in is turned off.")
                if (method, route) == ("POST", "/api/robinhood/login"):
                    b = self.body()
                    if not b.get("username") or not b.get("password"):
                        raise ValueError("Enter your Robinhood email and password.")
                    return self.send_json(app.client.login(b["username"], b["password"], b.get("mfaCode") or None))
                if (method, route) == ("POST", "/api/robinhood/verify"):
                    return self.send_json(app.client.submit_challenge(self.body().get("code") or None))
                if (method, route) in (("POST", "/api/robinhood/logout"), ("POST", "/api/disconnect")):
                    return self.send_json(app.disconnect())
                if (method, route) == ("POST", "/api/sync"):
                    return self.send_json(app.sync())
                self.send_json({"error": "Not found"}, 404)
            except (RobinhoodError, PlaidError, ValueError) as e:
                self.send_json({"error": str(e)}, 400)
            except OSError as e:
                self.send_json({"error": f"Couldn't reach {app.provider.capitalize()}: {e}"}, 502)
            except Exception as e:  # pragma: no cover - logged for debugging
                traceback.print_exc()
                self.send_json({"error": f"Unexpected error: {e}"}, 500)

        def static(self) -> None:
            rel = self.path.split("?")[0].lstrip("/") or "index.html"
            path = (DIST / rel).resolve()
            if not path.is_file() or DIST.resolve() not in path.parents:
                path = DIST / "index.html"
            if not path.is_file():
                body = b"Web app not built yet. Run: npm install && npm run build (in the dividends folder)."
                self.send_response(HTTPStatus.SERVICE_UNAVAILABLE)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(body)
                return
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            cache = "no-cache" if path.name in ("index.html", "sw.js") else "public, max-age=31536000, immutable"
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8787"))
    if host not in ("127.0.0.1", "localhost") and not APP_TOKEN:
        log("warning: listening beyond this computer without APP_TOKEN; anyone on the network can read your portfolio")
    app = App(Store(DATA_DIR))
    stop = threading.Event()
    threading.Thread(target=app.scheduler, args=(stop,), daemon=True).start()
    server = ThreadingHTTPServer((host, port), make_handler(app))
    log(f"Dividend tracker on http://{host}:{port}  (data in {DATA_DIR})")
    log(f"connections: Plaid ({app.plaid.env})" if app.plaid else
        "connections: direct Robinhood sign-in (set PLAID_CLIENT_ID and PLAID_SECRET to use Plaid instead)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()


if __name__ == "__main__":
    main()
