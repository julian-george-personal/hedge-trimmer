import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analysis.data import get_candles, list_events
from analysis.pandascore import find_match_start
from analysis.pre_match_volume import list_pre_match_volume
from analysis.price_spike import list_price_spike_stats

STATIC_DIR = Path(__file__).resolve().parent / "static"
PORT = 8420


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/events":
            self._send_json(list_events())
        elif parsed.path == "/api/candles":
            ticker = parse_qs(parsed.query).get("ticker", [""])[0]
            self._send_json(get_candles(ticker))
        elif parsed.path == "/api/match-start":
            query = parse_qs(parsed.query)
            event = {"close_time": query.get("close_time", [""])[0], "markets": [{"team_name": t} for t in query.get("team", [])]}
            self._send_json({"begin_at": find_match_start(event)})
        elif parsed.path == "/api/price-spike-stats":
            self._send_json(list_price_spike_stats())
        elif parsed.path == "/api/pre-match-volume":
            self._send_json(list_pre_match_volume())
        else:
            self._send_static(parsed.path)

    def _send_json(self, payload: object) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, url_path: str) -> None:
        # explorer.html and analysis.html are client-side views within the
        # single-page app served from index.html, not separate documents.
        if url_path in ("/", "/explorer.html", "/analysis.html"):
            relative_path = "index.html"
        else:
            relative_path = url_path.lstrip("/")
        file_path = (STATIC_DIR / relative_path).resolve()
        if STATIC_DIR not in file_path.parents or not file_path.is_file():
            self.send_error(404)
            return
        content_type = {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
        }.get(file_path.suffix, "application/octet-stream")
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        pass


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Serving analysis UI at http://127.0.0.1:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
