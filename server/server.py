"""Dividend tracker server: serves the web app, keeps the Robinhood session, and syncs once a day.

    python3 server/server.py            # http://127.0.0.1:8787

Environment:
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
import sys
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from robinhood import Client, RobinhoodError  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
APP_TOKEN = os.environ.get("APP_TOKEN", "")
HISTORY_DAYS = 3 * 365


class Store:
    """JSON files in DATA_DIR. The session file holds Robinhood tokens, so it's readable by its owner only."""

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
    def __init__(self, store: Store, client: Client | None = None):
        self.store = store
        self.settings = {"syncTime": "18:30", "autoSync": True, **store.read("settings.json", {})}
        self.state = store.read("state.json", {"lastSync": None, "lastError": None, "instruments": {}})
        self.client = client or Client(store.read("session.json", None), on_session_change=self._save_session)
        self.sync_lock = threading.Lock()
        self.syncing = False

    def _save_session(self, session: dict) -> None:
        self.store.write("session.json", session, private=True)

    def _save_state(self) -> None:
        self.store.write("state.json", self.state)

    # ───────────── Status & settings ─────────────

    def next_sync(self, now: dt.datetime | None = None) -> str | None:
        if not (self.client.connected and self.settings["autoSync"]):
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
            "connected": self.client.connected,
            "username": self.client.session.get("username"),
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
        if not (self.client.connected and self.settings["autoSync"]) or self.syncing:
            return False
        hh, mm = (int(x) for x in self.settings["syncTime"].split(":"))
        slot = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if now >= slot:
            return not self._synced_today(now)
        # Before today's slot: still catch up if the last sync is more than a day old (machine was off).
        last = self.state.get("lastSync")
        return not last or (now.astimezone() - dt.datetime.fromisoformat(last)) > dt.timedelta(hours=26)

    def sync(self) -> dict:
        if not self.client.connected:
            raise RobinhoodError("Connect Robinhood first.")
        if not self.sync_lock.acquire(blocking=False):
            raise RobinhoodError("A sync is already running.")
        self.syncing = True
        try:
            data = self.client.fetch_portfolio(self.state.setdefault("instruments", {}))
            previous = self.store.read("portfolio.json", {})
            now = dt.datetime.now().astimezone()
            value = sum(h["shares"] * h["price"] for h in data["holdings"])
            cost = sum(h["shares"] * h["avgCost"] for h in data["holdings"])
            history = [s for s in previous.get("history", []) if s["date"] != now.date().isoformat()]
            history.append({"date": now.date().isoformat(), "value": round(value, 2), "cost": round(cost, 2)})
            history = history[-HISTORY_DAYS:]
            portfolio = {**data, "history": history, "source": "robinhood", "syncedAt": now.isoformat()}
            self.store.write("portfolio.json", portfolio, private=True)
            self.state.update(lastSync=now.isoformat(), lastError=None)
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
                if (method, route) == ("POST", "/api/robinhood/login"):
                    b = self.body()
                    if not b.get("username") or not b.get("password"):
                        raise ValueError("Enter your Robinhood email and password.")
                    return self.send_json(app.client.login(b["username"], b["password"], b.get("mfaCode") or None))
                if (method, route) == ("POST", "/api/robinhood/verify"):
                    return self.send_json(app.client.submit_challenge(self.body().get("code") or None))
                if (method, route) == ("POST", "/api/robinhood/logout"):
                    app.client.logout()
                    return self.send_json(app.status())
                if (method, route) == ("POST", "/api/sync"):
                    return self.send_json(app.sync())
                self.send_json({"error": "Not found"}, 404)
            except (RobinhoodError, ValueError) as e:
                self.send_json({"error": str(e)}, 400)
            except OSError as e:
                self.send_json({"error": f"Couldn't reach Robinhood: {e}"}, 502)
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
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()


if __name__ == "__main__":
    main()
