import math

import duckdb

DATA_ROOT = "s3://hedge-trimmer-juliangeorge/kalshi"
PANDASCORE_DATA_ROOT = "s3://hedge-trimmer-juliangeorge/pandascore"

_CONNECTION: duckdb.DuckDBPyConnection | None = None


def _connect() -> duckdb.DuckDBPyConnection:
    global _CONNECTION
    if _CONNECTION is None:
        _CONNECTION = duckdb.connect()
        _CONNECTION.sql("INSTALL httpfs; LOAD httpfs; INSTALL aws; LOAD aws; CALL load_aws_credentials();")
    return _CONNECTION


def _records(query: str) -> list[dict]:
    # ThreadingHTTPServer runs requests concurrently; the shared connection
    # itself isn't safe for that, but cursor() gives each call its own.
    df = _connect().cursor().sql(query).df()
    return [
        {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in row.items()}
        for row in df.to_dict(orient="records")
    ]

_DOLLAR_COLUMNS = (
    "last_price_dollars",
    "yes_bid_dollars",
    "yes_ask_dollars",
    "settlement_value_dollars",
    "liquidity_dollars",
)
_NUMERIC_COLUMNS = ("volume_fp", "open_interest_fp")


def _tickers_with_candles() -> set[str]:
    paths = _connect().cursor().sql(f"SELECT file FROM glob('{DATA_ROOT}/candles/*/candles.parquet')").df()["file"]
    return {path.rsplit("/", 2)[-2].removeprefix("ticker=") for path in paths}


def list_markets() -> list[dict]:
    dollar_casts = ", ".join(f"TRY_CAST({col} AS DOUBLE) AS {col}" for col in _DOLLAR_COLUMNS)
    numeric_casts = ", ".join(f"TRY_CAST({col} AS DOUBLE) AS {col}" for col in _NUMERIC_COLUMNS)
    rows = _records(
        f"""
        SELECT
            ticker, event_ticker, series, title, yes_sub_title, no_sub_title,
            status, result, open_time, close_time, settlement_ts,
            {dollar_casts}, {numeric_casts}
        FROM read_parquet('{DATA_ROOT}/markets/*/markets.parquet', hive_partitioning = true)
        ORDER BY close_time DESC
        """
    )

    tickers_with_candles = _tickers_with_candles()
    for row in rows:
        row["has_candles"] = row["ticker"] in tickers_with_candles
    return rows


def list_events() -> list[dict]:
    events: dict[str, dict] = {}
    for market in list_markets():
        event = events.setdefault(
            market["event_ticker"],
            {
                "event_ticker": market["event_ticker"],
                "series": market["series"],
                "close_time": market["close_time"],
                "status": market["status"],
                "markets": [],
            },
        )
        event["markets"].append(
            {
                "ticker": market["ticker"],
                "team_name": market["yes_sub_title"],
                "result": market["result"],
                "has_candles": market["has_candles"],
                "volume": market["volume_fp"] or 0,
            }
        )

    events_list = list(events.values())
    for event in events_list:
        event["title"] = " vs ".join(m["team_name"] for m in event["markets"])
        event["has_candles"] = any(m["has_candles"] for m in event["markets"])
        event["volume"] = sum(m["volume"] for m in event["markets"])
    events_list = [event for event in events_list if event["volume"] > 0]
    events_list.sort(key=lambda e: e["close_time"], reverse=True)
    return events_list


def get_candles(ticker: str) -> list[dict]:
    candles_path = f"{DATA_ROOT}/candles/ticker={ticker}/candles.parquet"
    try:
        return _records(
            f"""
        SELECT
            end_period_ts AS t,
            TRY_CAST(volume_fp AS DOUBLE) AS volume,
            TRY_CAST(open_interest_fp AS DOUBLE) AS open_interest,
            TRY_CAST("yes_bid.open_dollars" AS DOUBLE) AS yes_bid_open,
            TRY_CAST("yes_bid.high_dollars" AS DOUBLE) AS yes_bid_high,
            TRY_CAST("yes_bid.low_dollars" AS DOUBLE) AS yes_bid_low,
            TRY_CAST("yes_bid.close_dollars" AS DOUBLE) AS yes_bid_close,
            TRY_CAST("yes_ask.open_dollars" AS DOUBLE) AS yes_ask_open,
            TRY_CAST("yes_ask.high_dollars" AS DOUBLE) AS yes_ask_high,
            TRY_CAST("yes_ask.low_dollars" AS DOUBLE) AS yes_ask_low,
            TRY_CAST("yes_ask.close_dollars" AS DOUBLE) AS yes_ask_close,
            TRY_CAST("price.open_dollars" AS DOUBLE) AS price_open,
            TRY_CAST("price.high_dollars" AS DOUBLE) AS price_high,
            TRY_CAST("price.low_dollars" AS DOUBLE) AS price_low,
            TRY_CAST("price.close_dollars" AS DOUBLE) AS price_close
        FROM read_parquet('{candles_path}')
        ORDER BY end_period_ts
        """
        )
    except duckdb.IOException:
        return []


def list_pandascore_matches() -> list[dict]:
    return _records(f"SELECT * FROM read_parquet('{PANDASCORE_DATA_ROOT}/matches.parquet')")
