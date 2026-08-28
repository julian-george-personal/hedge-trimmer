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
    seen_end_ts = set()
    chunk_start = start_ts
    while chunk_start < end_ts:
        chunk_end = min(chunk_start + chunk_seconds, end_ts)
        # Kalshi's start_ts/end_ts bounds are both inclusive, so the candle at
        # chunk_end is returned again as the first candle of the next chunk.
        for candle in _fetch_candlestick_chunk(client, series_ticker, ticker, chunk_start, chunk_end, period_interval):
            if candle["end_period_ts"] in seen_end_ts:
                continue
            seen_end_ts.add(candle["end_period_ts"])
            candles.append(candle)
        chunk_start = chunk_end
    return candles
