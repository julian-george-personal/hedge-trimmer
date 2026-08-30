import base64
import logging
import time
import uuid

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

logger = logging.getLogger("autotrader.clients.kalshi")

BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
API_PREFIX = "/trade-api/v2"
REQUEST_TIMEOUT_SECONDS = 30


def _raise_for_status_with_body(resp: requests.Response) -> None:
    """requests.HTTPError's default message omits the response body, which
    is where Kalshi puts the actual rejection reason (bad field name,
    insufficient balance, market closed, etc) — critical for diagnosing
    order-placement failures, especially since this order schema hasn't
    been verified field-for-field against live docs yet."""
    if resp.ok:
        return
    logger.error("Kalshi API error %s %s -> %s: %s", resp.request.method, resp.request.url, resp.status_code, resp.text)
    resp.raise_for_status()

# Kalshi deprecated /portfolio/orders (returns 410 deprecated_v1_order_endpoint
# as of 2026-08) in favor of /portfolio/events/orders: a single bid/ask order
# book scoped to the YES leg, fixed-point-decimal count/price strings, and
# required time_in_force/self_trade_prevention_type fields. See create_order.


class KalshiClient:
    """Standalone signed Kalshi client for the autotrader service. Deliberately
    not shared with ingestion.clients.kalshi — see autotrader's package docs
    for why this service keeps its own copy of every external client."""

    def __init__(self, key_id: str, private_key_pem: str, base_url: str = BASE_URL):
        self.key_id = key_id
        self.private_key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
        self.base_url = base_url
        self.session = requests.Session()

    def _auth_headers(self, method: str, path: str) -> dict:
        timestamp_ms = str(int(time.time() * 1000))
        message = f"{timestamp_ms}{method}{path}".encode("utf-8")
        signature = self.private_key.sign(
            message,
            padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
            hashes.SHA256(),
        )
        return {
            "KALSHI-ACCESS-KEY": self.key_id,
            "KALSHI-ACCESS-SIGNATURE": base64.b64encode(signature).decode("utf-8"),
            "KALSHI-ACCESS-TIMESTAMP": timestamp_ms,
        }

    def get(self, path: str, params: dict | None = None) -> dict:
        headers = self._auth_headers("GET", API_PREFIX + path)
        resp = self.session.get(self.base_url + path, headers=headers, params=params, timeout=REQUEST_TIMEOUT_SECONDS)
        _raise_for_status_with_body(resp)
        return resp.json()

    def post(self, path: str, body: dict) -> dict:
        logger.info("POST %s: %s", path, body)
        headers = self._auth_headers("POST", API_PREFIX + path)
        resp = self.session.post(self.base_url + path, headers=headers, json=body, timeout=REQUEST_TIMEOUT_SECONDS)
        _raise_for_status_with_body(resp)
        return resp.json()

    def delete(self, path: str) -> dict:
        headers = self._auth_headers("DELETE", API_PREFIX + path)
        resp = self.session.delete(self.base_url + path, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)
        _raise_for_status_with_body(resp)
        return resp.json() if resp.content else {}

    def open_markets(self, series_ticker: str) -> list[dict]:
        markets: list[dict] = []
        cursor = None
        while True:
            params = {"series_ticker": series_ticker, "status": "open", "limit": 1000}
            if cursor:
                params["cursor"] = cursor
            resp = self.get("/markets", params=params)
            page = resp.get("markets", [])
            markets.extend(page)
            cursor = resp.get("cursor")
            if not cursor or not page:
                break
        return markets

    def get_market(self, ticker: str) -> dict:
        return self.get(f"/markets/{ticker}")["market"]

    def get_balance_cents(self) -> int:
        return self.get("/portfolio/balance")["balance"]

    def get_positions(self) -> list[dict]:
        return self.get("/portfolio/positions").get("market_positions", [])

    def get_order(self, order_id: str) -> dict:
        return self.get(f"/portfolio/orders/{order_id}")["order"]

    def cancel_order(self, order_id: str) -> dict:
        return self.delete(f"/portfolio/events/orders/{order_id}")

    def create_order(
        self,
        ticker: str,
        side: str,
        action: str,
        count: int,
        order_type: str,
        price_cents: int | None = None,
    ) -> dict:
        """side: "yes"|"no". action: "buy"|"sell". order_type: "limit"|"market".
        price_cents (1-99, in terms of `side`'s own price) is required for
        limit orders; ignored for market orders, which use an
        immediate-or-cancel order at the marketable extreme instead, since
        v2 has no bare "market order" type.

        v2's order book only has a YES-leg bid/ask, so side+action is
        translated: buying/selling NO becomes the opposite book side at the
        complementary price (100 - price_cents)."""
        book_side = "bid" if action == "buy" else "ask"
        if side == "no":
            book_side = "ask" if book_side == "bid" else "bid"

        if order_type == "limit":
            yes_price_cents = price_cents if side == "yes" else 100 - price_cents
            time_in_force = "good_till_canceled"
        else:
            yes_price_cents = 99 if book_side == "bid" else 1
            time_in_force = "immediate_or_cancel"

        body = {
            "ticker": ticker,
            "client_order_id": str(uuid.uuid4()),
            "side": book_side,
            "count": f"{count:.2f}",
            "price": f"{yes_price_cents / 100:.2f}",
            "time_in_force": time_in_force,
            "self_trade_prevention_type": "taker_at_cross",
        }
        return self.post("/portfolio/events/orders", body)
