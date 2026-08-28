from ingestion.clients.kalshi import KalshiClient


def fetch_settled_markets(
    client: KalshiClient, series_ticker: str, min_close_ts: int, max_close_ts: int
) -> list[dict]:
    markets: list[dict] = []
    cursor = None
    while True:
        params = {
            "series_ticker": series_ticker,
            "status": "settled",
            "min_close_ts": min_close_ts,
            "max_close_ts": max_close_ts,
            "limit": 1000,
        }
        if cursor:
            params["cursor"] = cursor
        resp = client.get("/markets", params=params)
        page = resp.get("markets", [])
        markets.extend(page)
        cursor = resp.get("cursor")
        if not cursor or not page:
            break
    return markets
