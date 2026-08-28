import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from ingestion.clients.kalshi import KalshiClient
from ingestion.extract.candles import fetch_candlesticks
from ingestion.extract.markets import fetch_settled_markets
from ingestion.load.parquet_store import DEFAULT_DATA_ROOT, write_candles, write_markets


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
    return parser.parse_args()


def ingest_candles_for_market(client: KalshiClient, series_ticker: str, market: dict, data_root: str) -> int:
    ticker = market["ticker"]
    open_ts = int(datetime.fromisoformat(market["open_time"]).timestamp())
    close_ts = int(datetime.fromisoformat(market["close_time"]).timestamp())
    candles = fetch_candlesticks(client, series_ticker, ticker, open_ts, close_ts)
    write_candles(candles, ticker, data_root)
    return len(candles)


def main() -> None:
    args = parse_args()
    client = KalshiClient.from_credentials_dir()

    min_close_ts = int(parse_date_arg(args.start_date).timestamp())
    max_close_ts = int((parse_date_arg(args.end_date) + timedelta(days=1)).timestamp())

    markets = fetch_settled_markets(client, args.series_ticker, min_close_ts, max_close_ts)
    print(f"found {len(markets)} settled markets closing between {args.start_date} and {args.end_date}")
    write_markets(markets, args.series_ticker, args.data_root)

    ticker_filter = set(args.tickers.split(",")) if args.tickers else None
    if ticker_filter:
        markets = [m for m in markets if m["ticker"] in ticker_filter]

    for market in markets:
        count = ingest_candles_for_market(client, args.series_ticker, market, args.data_root)
        print(f"  {market['ticker']}: {count} candles")


if __name__ == "__main__":
    main()
