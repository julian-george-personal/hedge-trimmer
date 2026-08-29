import base64
import time
import uuid

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
API_PREFIX = "/trade-api/v2"
REQUEST_TIMEOUT_SECONDS = 30

# The exact create-order field names below (ticker/client_order_id/side/
# action/count/type/yes_price/no_price) match Kalshi's documented v2 shape
# as of this writing, but weren't re-verified against docs.kalshi.com's live
# reference during this change (the fetch tool available here couldn't pull
# it). Confirm against the current API reference before ever calling
# create_order with armed=True.


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
        resp.raise_for_status()
        return resp.json()

    def post(self, path: str, body: dict) -> dict:
        headers = self._auth_headers("POST", API_PREFIX + path)
        resp = self.session.post(self.base_url + path, headers=headers, json=body, timeout=REQUEST_TIMEOUT_SECONDS)
        resp.raise_for_status()
        return resp.json()

    def delete(self, path: str) -> dict:
        headers = self._auth_headers("DELETE", API_PREFIX + path)
        resp = self.session.delete(self.base_url + path, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)
        resp.raise_for_status()
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
        return self.delete(f"/portfolio/orders/{order_id}")

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
        price_cents is required for limit orders (1-99), ignored for market
        orders."""
        body = {
            "ticker": ticker,
            "client_order_id": str(uuid.uuid4()),
            "side": side,
            "action": action,
            "count": count,
            "type": order_type,
        }
        if order_type == "limit":
            price_field = "yes_price" if side == "yes" else "no_price"
            body[price_field] = price_cents
        return self.post("/portfolio/orders", body)["order"]
