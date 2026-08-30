import argparse
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from ingestion.clients.kalshi import KalshiClient
from ingestion.extract.candles import fetch_candlesticks
from ingestion.extract.markets import fetch_settled_markets
from ingestion.load.parquet_store import DEFAULT_DATA_ROOT, candles_exist, write_candles, write_markets

MARKET_RETRY_ATTEMPTS = 3
MARKET_RETRY_BACKOFF_SECONDS = 5


def parse_date_arg(date_str: str) -> datetime:
    return datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingest settled Kalshi markets + candlesticks for a series, filtered by close date"
    )
    parser.add_argument("--series-ticker", default="KXCS2GAME")
    parser.add_argument("--start-date", required=True, help="YYYY-MM-DD, inclusive, filters by market close time")
    parser.add_argument("--end-date", required=True, help="YYYY-MM-DD, inclusive, filters by market close time")
    parser.add_argument(
        "--tickers",
        help="Comma-separated market tickers to restrict candlestick ingestion to "
        "(the parallelism boundary: split a ticker list across invocations)",
    )
    parser.add_argument("--data-root", default=DEFAULT_DATA_ROOT, help="Local path or s3:// URI for Parquet output")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace markets.parquet with exactly this run's results instead of merging into what's "
        "already there (default: merge, so a narrow date range doesn't delete out-of-range history)",
    )
    return parser.parse_args()


def ingest_candles_for_market(client: KalshiClient, series_ticker: str, market: dict, data_root: str) -> int:
    ticker = market["ticker"]
    open_ts = int(datetime.fromisoformat(market["open_time"]).timestamp())
    close_ts = int(datetime.fromisoformat(market["close_time"]).timestamp())
    candles = fetch_candlesticks(client, series_ticker, ticker, open_ts, close_ts)
    write_candles(candles, ticker, data_root)
    return len(candles)


def run(
    client: KalshiClient,
    series_ticker: str,
    start_date: datetime,
    end_date: datetime,
    data_root: str = DEFAULT_DATA_ROOT,
    ticker_filter: set[str] | None = None,
    overwrite: bool = False,
    skip_existing_candles: bool = False,
) -> None:
    min_close_ts = int(start_date.timestamp())
    max_close_ts = int((end_date + timedelta(days=1)).timestamp())

    markets = fetch_settled_markets(client, series_ticker, min_close_ts, max_close_ts)
    print(f"found {len(markets)} settled markets closing between {start_date.date()} and {end_date.date()}")
    write_markets(markets, series_ticker, data_root, overwrite=overwrite)

    if ticker_filter:
        markets = [m for m in markets if m["ticker"] in ticker_filter]

    for market in markets:
        ticker = market["ticker"]
        if skip_existing_candles and candles_exist(ticker, data_root):
            continue
        for attempt in range(1, MARKET_RETRY_ATTEMPTS + 1):
            try:
                count = ingest_candles_for_market(client, series_ticker, market, data_root)
                print(f"  {ticker}: {count} candles")
                break
            except Exception as exc:
                if attempt == MARKET_RETRY_ATTEMPTS:
                    print(f"  {ticker}: FAILED after {attempt} attempts ({exc})")
                else:
                    time.sleep(MARKET_RETRY_BACKOFF_SECONDS * attempt)


def main() -> None:
    args = parse_args()
    client = KalshiClient.from_credentials_dir()
    ticker_filter = set(args.tickers.split(",")) if args.tickers else None
    run(
        client,
        args.series_ticker,
        parse_date_arg(args.start_date),
        parse_date_arg(args.end_date),
        args.data_root,
        ticker_filter,
        overwrite=args.overwrite,
    )


if __name__ == "__main__":
    main()
