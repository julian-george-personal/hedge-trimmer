import json
import logging
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from autotrader.storage.config import load_config, save_config
from autotrader.storage.state import Store
from autotrader.web.auth import is_authorized
from autotrader.web.dashboard import render_dashboard
from autotrader.web.debug_view import render_debug_view

logger = logging.getLogger("autotrader.web")

_CONTROL_ACTIONS = {
    "start": {"enabled": True},
    "stop": {"enabled": False},
    "arm": {"armed": True},
    "disarm": {"armed": False},
}


def _config_updates_from_fields(current, fields: dict) -> dict:
    updates = {}
    for field in (
        "side",
        "bet_per_match_dollars",
        "pre_match_volume_min",
        "pre_match_volume_max",
        "win_prob_min",
        "win_prob_max",
        "stop_loss_percent",
        "take_profit_percent",
        "lead_time_minutes",
        "order_style",
    ):
        if field not in fields:
            continue
        current_value = getattr(current, field)
        updates[field] = fields[field] if isinstance(current_value, str) else float(fields[field])
    return updates


def build_handler(store: Store, username: str, password: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def _authorized(self) -> bool:
            return is_authorized(self.headers.get("Authorization"), username, password)

        def _require_auth(self) -> bool:
            if self._authorized():
                return True
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="autotrader"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False

        def do_GET(self) -> None:
            try:
                self._do_GET()
            except Exception:
                logger.exception("unhandled error handling GET %s", self.path)
                self.send_error(500)

        def _do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                self._send_json(200, {"status": "ok"})
                return
            if not self._require_auth():
                return
            if parsed.path == "/":
                saved = "saved" in parse_qs(parsed.query)
                self._send_html(200, render_dashboard(load_config(store), store.list_positions(), saved=saved))
            elif parsed.path == "/debug":
                self._send_html(200, render_debug_view(store.list_market_scans()))
            elif parsed.path == "/api/positions":
                self._send_json(200, store.list_positions())
            else:
                self.send_error(404)

        def do_POST(self) -> None:
            try:
                self._do_POST()
            except Exception:
                logger.exception("unhandled error handling POST %s", self.path)
                self.send_error(500)

        def _do_POST(self) -> None:
            if not self._require_auth():
                return
            parsed = urlparse(self.path)
            length = int(self.headers.get("Content-Length", 0))
            fields = {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode("utf-8")).items()}

            if parsed.path == "/config":
                current = load_config(store)
                updates = _config_updates_from_fields(current, fields)
                updates["filters_updated_at"] = datetime.now(timezone.utc).isoformat()
                save_config(store, current.with_updates(**updates))
                logger.info("config updated: %s", updates)
                self._redirect("/?saved=1")
                return
            elif parsed.path == "/control":
                action = fields.get("action", "")
                updates = _CONTROL_ACTIONS.get(action)
                if updates:
                    save_config(store, load_config(store).with_updates(**updates))
                    logger.info("control action %r applied: %s", action, updates)
                else:
                    logger.warning("ignored unknown control action %r", action)
                self._redirect("/")
            else:
                self.send_error(404)

        def _redirect(self, location: str) -> None:
            self.send_response(303)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _send_json(self, status: int, payload: object) -> None:
            body = json.dumps(payload, default=str).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_html(self, status: int, html_body: str) -> None:
            body = html_body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args) -> None:
            # Route the standard per-request access log through our own
            # logger (-> CloudWatch) instead of BaseHTTPRequestHandler's
            # default of writing straight to stderr with no timestamp/level.
            logger.info("%s - %s", self.address_string(), format % args)

    return Handler


def serve(store: Store, username: str, password: str, port: int) -> None:
    server = ThreadingHTTPServer(("0.0.0.0", port), build_handler(store, username, password))
    logger.info("autotrader web UI listening on port %d", port)
    server.serve_forever()
