from analysis.data import candle_price_series, list_events
from analysis.match_timing import match_start_reference, volume_before
from analysis.pandascore import find_match_start


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


def _min_price_from(series: list[dict], target_ts: int) -> float | None:
    prices = [point["price"] for point in series if point["t"] >= target_ts]
    return min(prices) if prices else None


def _event_price_spike(event: dict, all_series: dict[str, list[dict]]) -> dict | None:
    if len(event["markets"]) != 2:
        return None
    series_by_market = [all_series.get(m["ticker"]) for m in event["markets"]]
    if not all(series_by_market):
        return None

    ref_ts = match_start_reference(event)
    start_prices = [_price_at(series, ref_ts) for series in series_by_market]
    max_prices = [_max_price_from(series, ref_ts) for series in series_by_market]
    min_prices = [_min_price_from(series, ref_ts) for series in series_by_market]
    if None in start_prices or None in max_prices or start_prices[0] == start_prices[1]:
        return None

    underdog = 0 if start_prices[0] < start_prices[1] else 1
    overdog = 1 - underdog
    volume_before_start = sum(volume_before(series, ref_ts) for series in series_by_market)
    return {
        "event_ticker": event["event_ticker"],
        "underdog_start_price": start_prices[underdog],
        "underdog_max_price": max_prices[underdog],
        "underdog_min_price": min_prices[underdog],
        "overdog_start_price": start_prices[overdog],
        "overdog_max_price": max_prices[overdog],
        "overdog_min_price": min_prices[overdog],
        "volume_before_start": volume_before_start,
        "has_pandascore_start": find_match_start(event) is not None,
    }


_price_spike_stats_cache: list[dict] | None = None


def list_price_spike_stats() -> list[dict]:
    """Per-event underdog/overdog start price (at PandaScore match start, or
    2h-before-close as a fallback) and max/min price from that point through
    the end of the candle data. Powers the analysis-page price-spike widget.
    Cached in memory for the process lifetime, same operational model as
    candle_price_series and the pandascore match-start index."""
    global _price_spike_stats_cache
    if _price_spike_stats_cache is None:
        all_series = candle_price_series()
        stats = (_event_price_spike(event, all_series) for event in list_events())
        _price_spike_stats_cache = [stat for stat in stats if stat is not None]
    return _price_spike_stats_cache
