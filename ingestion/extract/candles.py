from ingestion.clients.kalshi import KalshiClient

PERIOD_INTERVAL_1MIN = 1

# Kalshi rejects requests spanning more than 5000 candlesticks; stay well under that.
MAX_CANDLES_PER_REQUEST = 4000


def _fetch_candlestick_chunk(
    client: KalshiClient, series_ticker: str, ticker: str, start_ts: int, end_ts: int, period_interval: int
) -> list[dict]:
    resp = client.get(
        f"/series/{series_ticker}/markets/{ticker}/candlesticks",
        params={"start_ts": start_ts, "end_ts": end_ts, "period_interval": period_interval},
    )
    return resp.get("candlesticks", [])


def fetch_candlesticks(
    client: KalshiClient,
    series_ticker: str,
    ticker: str,
    start_ts: int,
    end_ts: int,
    period_interval: int = PERIOD_INTERVAL_1MIN,
) -> list[dict]:
    chunk_seconds = MAX_CANDLES_PER_REQUEST * period_interval * 60
    candles = []
    chunk_start = start_ts
    while chunk_start < end_ts:
        chunk_end = min(chunk_start + chunk_seconds, end_ts)
        candles.extend(_fetch_candlestick_chunk(client, series_ticker, ticker, chunk_start, chunk_end, period_interval))
        chunk_start = chunk_end
    return candles
