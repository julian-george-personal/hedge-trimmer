from datetime import datetime

from analysis.data import candle_price_series, list_events
from analysis.pandascore import find_match_start

# When PandaScore has no matching match record, fall back to this many
# seconds before the market closed as the "match start" reference point —
# mirrors the chart's default-zoom fallback in explorer.js.
MATCH_START_FALLBACK_SECONDS = 2 * 60 * 60


def _epoch_seconds(iso_ts: str) -> int:
    return int(datetime.fromisoformat(iso_ts.replace("Z", "+00:00")).timestamp())


def _price_at(series: list[dict], target_ts: int) -> float | None:
    if not series:
        return None
    chosen = series[0]
    for point in series:
        if point["t"] > target_ts:
            break
        chosen = point
    return chosen["price"]


def _max_price_from(series: list[dict], target_ts: int) -> float | None:
    prices = [point["price"] for point in series if point["t"] >= target_ts]
    return max(prices) if prices else None


def _volume_before(series: list[dict], target_ts: int) -> float:
    return sum(point["volume"] for point in series if point["t"] < target_ts)


def _event_price_spike(event: dict, all_series: dict[str, list[dict]]) -> dict | None:
    if len(event["markets"]) != 2:
        return None
    series_by_market = [all_series.get(m["ticker"]) for m in event["markets"]]
    if not all(series_by_market):
        return None

    begin_at = find_match_start(event)
    ref_ts = _epoch_seconds(begin_at) if begin_at else _epoch_seconds(event["close_time"]) - MATCH_START_FALLBACK_SECONDS
    start_prices = [_price_at(series, ref_ts) for series in series_by_market]
    max_prices = [_max_price_from(series, ref_ts) for series in series_by_market]
    if None in start_prices or None in max_prices or start_prices[0] == start_prices[1]:
        return None

    underdog = 0 if start_prices[0] < start_prices[1] else 1
    overdog = 1 - underdog
    volume_before_start = sum(_volume_before(series, ref_ts) for series in series_by_market)
    return {
        "event_ticker": event["event_ticker"],
        "underdog_start_price": start_prices[underdog],
        "underdog_max_price": max_prices[underdog],
        "overdog_start_price": start_prices[overdog],
        "overdog_max_price": max_prices[overdog],
        "volume_before_start": volume_before_start,
        "has_pandascore_start": begin_at is not None,
    }


_price_spike_stats_cache: list[dict] | None = None


def list_price_spike_stats() -> list[dict]:
    """Per-event underdog/overdog start price (at PandaScore match start, or
    2h-before-close as a fallback) and max price from that point through the
    end of the candle data. Powers the analysis-page price-spike widget.
    Cached in memory for the process lifetime, same operational model as
    candle_price_series and the pandascore match-start index."""
    global _price_spike_stats_cache
    if _price_spike_stats_cache is None:
        all_series = candle_price_series()
        stats = (_event_price_spike(event, all_series) for event in list_events())
        _price_spike_stats_cache = [stat for stat in stats if stat is not None]
    return _price_spike_stats_cache
