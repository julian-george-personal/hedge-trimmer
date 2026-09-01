import json

import duckdb

from analysis.data import _connect, _records
from analysis.price_spike import _event_price_spike

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
    /prices-history only has one price per point (no separate bid/ask — see
    project_polymarket_ingestion_scoping memory), so yes_bid/yes_ask/price
    are all set to that same value (or its complement for outcome index 1)
    and open_interest is left at None — an honest stand-in, not a real
    bid/ask spread. Volume, unlike bid/ask, is real: ingestion buckets raw
    trade notional (size * price) into each candle (see
    ingestion/extract/polymarket_trades.py's merge_trade_volume) since
    /prices-history has none of its own — halved between this market's two
    synthetic tickers so summing both (as explorer.js's totalVolumeSeries
    does, mirroring Kalshi's two-tickers-per-event volume) reconstructs the
    true total rather than double-counting it."""
    try:
        market_id, outcome_index_str = ticker.rsplit(":", 1)
        outcome_index = int(outcome_index_str)
    except ValueError:
        return []

    candles_path = f"{DATA_ROOT}/candles/market_id={market_id}/candles.parquet"
    try:
        rows = _records(
            f"""
            SELECT t, TRY_CAST(p AS DOUBLE) AS p, TRY_CAST(volume AS DOUBLE) AS volume
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
                "volume": (row["volume"] or 0) / 2,
                "open_interest": None,
                "yes_bid_open": p, "yes_bid_high": p, "yes_bid_low": p, "yes_bid_close": p,
                "yes_ask_open": p, "yes_ask_high": p, "yes_ask_low": p, "yes_ask_close": p,
                "price_open": p, "price_high": p, "price_low": p, "price_close": p,
            }
        )
    return candles


_candle_price_series_cache: dict[str, list[dict]] | None = None


def candle_price_series() -> dict[str, list[dict]]:
    """Kalshi-shaped price series (see analysis.data.candle_price_series) for
    every synthetic per-team ticker, keyed and sorted the same way. Polymarket
    has one price per point and no per-candle low/high, so low/high/ask/bid
    all collapse to that one price — an honest stand-in, not fabricated
    spread data. Volume is real (see get_candles) and halved the same way,
    so summing both tickers' series (as _event_price_spike's
    volume_before_start does) reconstructs the true total. Powers
    list_price_spike_stats below, which reuses price_spike.py's per-event
    computation unmodified."""
    global _candle_price_series_cache
    if _candle_price_series_cache is None:
        # union_by_name tolerates schema drift across candle files — e.g. a
        # handful of orphaned market_ids from an earlier ingestion pass still
        # have the pre-volume-fix {t, p} schema (see the ingestion changelog
        # around 2026-08-31); without it, one such file crashes this entire
        # glob read rather than just missing a "volume" column on its rows.
        rows = _records(
            f"""
            SELECT market_id, t, TRY_CAST(p AS DOUBLE) AS p, TRY_CAST(volume AS DOUBLE) AS volume
            FROM read_parquet('{DATA_ROOT}/candles/*/candles.parquet', hive_partitioning = true, union_by_name = true)
            ORDER BY market_id, t
            """
        )
        series: dict[str, list[dict]] = {}
        for row in rows:
            p = row["p"]
            if p is None:
                continue
            half_volume = (row["volume"] or 0) / 2
            for outcome_index in (0, 1):
                value = p if outcome_index == 0 else 1 - p
                series.setdefault(f"{row['market_id']}:{outcome_index}", []).append(
                    {
                        "t": row["t"],
                        "price": value, "low": value, "high": value,
                        "ask_price": value, "ask_low": value, "ask_high": value,
                        "bid_price": value, "bid_low": value, "bid_high": value,
                        "volume": half_volume,
                    }
                )
        _candle_price_series_cache = series
    return _candle_price_series_cache


_price_spike_stats_cache: list[dict] | None = None


def list_price_spike_stats() -> list[dict]:
    """Polymarket counterpart to analysis.price_spike.list_price_spike_stats
    — reuses its per-event stat computation unmodified, since that function
    only needs an event plus a ticker-keyed price series and neither is
    Kalshi-specific. The ask/bid fields it produces come out identical to the
    mid ones here (candle_price_series sets bid=ask=price), so the
    optimizer widget's "realistic spread" toggle is a documented no-op for
    this source rather than silently wrong."""
    global _price_spike_stats_cache
    if _price_spike_stats_cache is None:
        all_series = candle_price_series()
        stats = (_event_price_spike(event, all_series) for event in list_events())
        _price_spike_stats_cache = [stat for stat in stats if stat is not None]
    return _price_spike_stats_cache
