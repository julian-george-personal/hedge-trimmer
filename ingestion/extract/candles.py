from ingestion.clients.kalshi import KalshiClient

PERIOD_INTERVAL_1MIN = 1


def fetch_candlesticks(
    client: KalshiClient,
    series_ticker: str,
    ticker: str,
    start_ts: int,
    end_ts: int,
    period_interval: int = PERIOD_INTERVAL_1MIN,
) -> list[dict]:
    resp = client.get(
        f"/series/{series_ticker}/markets/{ticker}/candlesticks",
        params={"start_ts": start_ts, "end_ts": end_ts, "period_interval": period_interval},
    )
    return resp.get("candlesticks", [])
