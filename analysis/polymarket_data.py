import json

import duckdb

from analysis.data import _connect, _records

DATA_ROOT = "s3://hedge-trimmer-juliangeorge/polymarket"


def _tickers_with_candles() -> set[str]:
    paths = _connect().cursor().sql(f"SELECT file FROM glob('{DATA_ROOT}/candles/*/candles.parquet')").df()["file"]
    return {path.rsplit("/", 2)[-2].removeprefix("market_id=") for path in paths}


def _market_result(outcome_prices: list[str] | None, outcome_index: int) -> str:
    """Kalshi's result field is "yes"/"no"/"" (won/lost/unresolved) per market
    — mapped here from Polymarket's settled outcomePrices ("1"/"0" per
    outcome) so explorer.js's outcomeBadge() needs no source-specific case."""
    if not outcome_prices:
        return ""
    if outcome_prices[outcome_index] == "1":
        return "yes"
    if outcome_prices[outcome_index] == "0":
        return "no"
    return ""


def list_events() -> list[dict]:
    """Kalshi-shaped events built from moneyline markets only (see
    ingestion/extract/polymarket_markets.py's is_match_moneyline). Each
    Polymarket moneyline market already carries both teams' outcomes on one
    row, unlike Kalshi's one-ticker-per-team — split here into two synthetic
    tickers ("<market_id>:0"/"<market_id>:1") so the rest of the app (which
    fetches candles per market in event["markets"]) doesn't need to know the
    difference."""
    rows = _records(
        f"""
        SELECT id, event_title, question, outcomes, outcomePrices, startDate, closedTime, endDate,
               TRY_CAST(volume AS DOUBLE) AS volume
        FROM read_parquet('{DATA_ROOT}/markets/tag=*/markets.parquet', hive_partitioning = true)
        WHERE is_match_moneyline = true
        """
    )

    tickers_with_candles = _tickers_with_candles()
    events = []
    for row in rows:
        market_id = str(row["id"])
        has_candles = market_id in tickers_with_candles
        outcomes = json.loads(row["outcomes"]) if row["outcomes"] else []
        outcome_prices = json.loads(row["outcomePrices"]) if row["outcomePrices"] else None
        volume = row["volume"] or 0

        markets = [
            {
                "ticker": f"{market_id}:{i}",
                "team_name": team_name,
                "result": _market_result(outcome_prices, i),
                "has_candles": has_candles,
                "volume": volume,
            }
            for i, team_name in enumerate(outcomes)
        ]

        events.append(
            {
                "event_ticker": market_id,
                "series": "polymarket",
                "close_time": row["closedTime"] or row["endDate"] or row["startDate"],
                "status": "closed",
                "markets": markets,
                "title": row["question"] or row["event_title"],
                "has_candles": has_candles,
                "volume": volume,
            }
        )

    events = [event for event in events if event["volume"] > 0]
    events.sort(key=lambda e: e["close_time"], reverse=True)
    return events


def get_candles(ticker: str) -> list[dict]:
    """Ticker is "<market_id>:<outcome_index>" (see list_events). Polymarket's
    /prices-history only has one price per point (no separate bid/ask —
    see project_polymarket_ingestion_scoping memory) and no per-point
    volume/open-interest, so yes_bid/yes_ask/price are all set to that same
    value (or its complement for outcome index 1) and volume/open_interest
    are left at 0/None — an honest stand-in, not a real bid/ask spread or
    per-minute volume, both of which Polymarket doesn't expose historically."""
    try:
        market_id, outcome_index_str = ticker.rsplit(":", 1)
        outcome_index = int(outcome_index_str)
    except ValueError:
        return []

    candles_path = f"{DATA_ROOT}/candles/market_id={market_id}/candles.parquet"
    try:
        rows = _records(
            f"""
            SELECT t, TRY_CAST(p AS DOUBLE) AS p
            FROM read_parquet('{candles_path}')
            ORDER BY t
            """
        )
    except duckdb.IOException:
        return []

    candles = []
    for row in rows:
        p = row["p"]
        if p is not None and outcome_index == 1:
            p = 1 - p
        candles.append(
            {
                "t": row["t"],
                "volume": 0,
                "open_interest": None,
                "yes_bid_open": p, "yes_bid_high": p, "yes_bid_low": p, "yes_bid_close": p,
                "yes_ask_open": p, "yes_ask_high": p, "yes_ask_low": p, "yes_ask_close": p,
                "price_open": p, "price_high": p, "price_low": p, "price_close": p,
            }
        )
    return candles
