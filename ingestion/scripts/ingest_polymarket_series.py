import argparse
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from ingestion.clients.polymarket import PolymarketClient
from ingestion.extract.polymarket_candles import fetch_price_history, market_price_token
from ingestion.extract.polymarket_markets import fetch_closed_markets
from ingestion.load.parquet_store import (
    DEFAULT_POLYMARKET_DATA_ROOT,
    polymarket_candles_exist,
    write_polymarket_candles,
    write_polymarket_markets,
)

MARKET_RETRY_ATTEMPTS = 3
MARKET_RETRY_BACKOFF_SECONDS = 5


def parse_date_arg(date_str: str) -> datetime:
    return datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingest closed Polymarket markets + price history for a tag, filtered by start date"
    )
    # Gamma's CS2 tagging has drifted over time — "csgo" (2024-09 through
    # ~2025-10) and "cs2" (sparse, mostly prop-bet events) are both stale for
    # anything recent. "counter-strike-2" is the tag actually applied to
    # current per-match events (confirmed active 2025-09-24 through today).
    parser.add_argument("--tag-slug", default="counter-strike-2")
    parser.add_argument("--start-date", required=True, help="YYYY-MM-DD, inclusive, filters by market start time")
    parser.add_argument("--end-date", required=True, help="YYYY-MM-DD, inclusive, filters by market start time")
    parser.add_argument(
        "--market-ids",
        help="Comma-separated market ids to restrict price-history ingestion to "
        "(the parallelism boundary: split a market list across invocations)",
    )
    parser.add_argument("--data-root", default=DEFAULT_POLYMARKET_DATA_ROOT, help="Local path or s3:// URI for Parquet output")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace markets.parquet with exactly this run's results instead of merging into what's "
        "already there (default: merge, so a narrow date range doesn't delete out-of-range history)",
    )
    parser.add_argument(
        "--include-props",
        action="store_true",
        help="Also fetch price history for non-moneyline markets (per-map winner, handicaps, totals) — "
        "off by default since these outnumber moneylines ~10:1 and the analysis UI only reads moneylines",
    )
    parser.add_argument(
        "--skip-existing-candles",
        action="store_true",
        help="Skip candle fetching for any market that already has a candles.parquet at data-root — "
        "lets a large backfill resume after a crash without re-fetching hours of already-done markets",
    )
    return parser.parse_args()


def _parse_ts(iso_string: str) -> int:
    return int(datetime.fromisoformat(iso_string.replace("Z", "+00:00")).timestamp())


def ingest_candles_for_market(client: PolymarketClient, market: dict, data_root: str) -> int:
    market_id = market["id"]
    token_id = market_price_token(market)
    start_ts = _parse_ts(market["startDate"])
    end_ts = _parse_ts(market.get("closedTime") or market["endDate"])
    candles = fetch_price_history(client, token_id, start_ts, end_ts)
    write_polymarket_candles(candles, market_id, data_root)
    return len(candles)


def run(
    client: PolymarketClient,
    tag_slug: str,
    start_date: datetime,
    end_date: datetime,
    data_root: str = DEFAULT_POLYMARKET_DATA_ROOT,
    market_id_filter: set[str] | None = None,
    overwrite: bool = False,
    skip_existing_candles: bool = False,
    include_props: bool = False,
) -> None:
    min_start_ts = int(start_date.timestamp())
    max_start_ts = int((end_date + timedelta(days=1)).timestamp())

    markets = fetch_closed_markets(client, tag_slug, min_start_ts, max_start_ts)
    print(f"found {len(markets)} closed markets starting between {start_date.date()} and {end_date.date()}")
    write_polymarket_markets(markets, tag_slug, data_root, overwrite=overwrite)

    if not include_props:
        markets = [m for m in markets if m["is_match_moneyline"]]
    if market_id_filter:
        markets = [m for m in markets if m["id"] in market_id_filter]
    print(f"fetching price history for {len(markets)} markets")

    for market in markets:
        market_id = market["id"]
        if skip_existing_candles and polymarket_candles_exist(market_id, data_root):
            continue
        for attempt in range(1, MARKET_RETRY_ATTEMPTS + 1):
            try:
                count = ingest_candles_for_market(client, market, data_root)
                print(f"  {market_id} ({market['question']}): {count} price points")
                break
            except Exception as exc:
                if attempt == MARKET_RETRY_ATTEMPTS:
                    print(f"  {market_id}: FAILED after {attempt} attempts ({exc})")
                else:
                    time.sleep(MARKET_RETRY_BACKOFF_SECONDS * attempt)


def main() -> None:
    args = parse_args()
    client = PolymarketClient()
    market_id_filter = set(args.market_ids.split(",")) if args.market_ids else None
    run(
        client,
        args.tag_slug,
        parse_date_arg(args.start_date),
        parse_date_arg(args.end_date),
        args.data_root,
        market_id_filter,
        overwrite=args.overwrite,
        include_props=args.include_props,
        skip_existing_candles=args.skip_existing_candles,
    )


if __name__ == "__main__":
    main()
