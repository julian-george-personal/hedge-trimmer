from analysis.data import candle_price_series, list_events
from analysis.match_timing import match_start_reference, volume_before
from analysis.pandascore import find_match_start


def _price_at(series: list[dict], target_ts: int, key: str = "price") -> float | None:
    if not series:
        return None
    chosen = series[0]
    for point in series:
        if point["t"] > target_ts:
            break
        chosen = point
    return chosen[key]


def _max_price_from(series: list[dict], target_ts: int) -> float | None:
    prices = [point["price"] for point in series if point["t"] >= target_ts]
    return max(prices) if prices else None


def _min_price_from(series: list[dict], target_ts: int) -> float | None:
    prices = [point["price"] for point in series if point["t"] >= target_ts]
    return min(prices) if prices else None


# Record-high/record-low breakpoints of the price path from match start
# onward: [price, seconds_since_start] pairs, strictly increasing in both
# price and time. For any level L, the first time price reaches L is exactly
# the time of the first breakpoint whose price >= L (for record highs; <=
# for record lows) — so these small lists answer a "first touch of any
# take-profit/stop-loss level" query for every possible level at once,
# without shipping the full per-minute series to the browser. Powers
# analysis.js's dollar-profit widget, which needs the actual order in which
# levels were crossed (unlike the plain max/min above, which can't tell
# whether a stop-loss level was crossed before or after a take-profit one).
#
# Tracks each candle's intra-period high/low, not just its close: a price
# can touch a stop-loss or take-profit level and recover within one 1-minute
# candle, which the close alone would hide entirely (confirmed against raw
# data — a candle's yes_bid low routinely sits far below its close). Only
# last_price (the settlement fallback) uses the close, since that's the
# price actually standing at the end of the observed window.
#
# low_key/high_key/price_key let this run against the bid series instead of
# the mid: a realistic fill sells at the bid for both take-profit and
# stop-loss exits (you're selling either way), so the "realistic" variant
# below runs this same logic over bid_low/bid_high/bid_price rather than
# the naive mid low/high/price.
def _running_extrema_breakpoints(
    series: list[dict], target_ts: int, low_key: str = "low", high_key: str = "high", price_key: str = "price"
) -> dict:
    points = [point for point in series if point["t"] >= target_ts]
    if not points:
        return {"tp": [], "sl": [], "last_price": None}

    tp_breakpoints = []
    sl_breakpoints = []
    running_max = float("-inf")
    running_min = float("inf")
    for point in points:
        t_offset = point["t"] - target_ts
        if point[high_key] > running_max:
            running_max = point[high_key]
            tp_breakpoints.append([running_max, t_offset])
        if point[low_key] < running_min:
            running_min = point[low_key]
            sl_breakpoints.append([running_min, t_offset])
    return {"tp": tp_breakpoints, "sl": sl_breakpoints, "last_price": points[-1][price_key]}


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

    breakpoints = [_running_extrema_breakpoints(series, ref_ts) for series in series_by_market]

    # Realistic-fill counterparts: a real buy pays the ask, and a real sell
    # (whether take-profit or stop-loss) receives the bid — never the mid
    # the fields above use. entry_ask can be None even when the mid start
    # price isn't (e.g. a zero-quoted ask side); callers must handle that,
    # same as any other missing-data case.
    entry_asks = [_price_at(series, ref_ts, key="ask_price") for series in series_by_market]
    bid_breakpoints = [
        _running_extrema_breakpoints(series, ref_ts, low_key="bid_low", high_key="bid_high", price_key="bid_price")
        for series in series_by_market
    ]

    underdog = 0 if start_prices[0] < start_prices[1] else 1
    overdog = 1 - underdog
    volume_before_start = sum(volume_before(series, ref_ts) for series in series_by_market)
    return {
        "event_ticker": event["event_ticker"],
        "underdog_start_price": start_prices[underdog],
        "underdog_max_price": max_prices[underdog],
        "underdog_min_price": min_prices[underdog],
        "underdog_tp_breakpoints": breakpoints[underdog]["tp"],
        "underdog_sl_breakpoints": breakpoints[underdog]["sl"],
        "underdog_last_price": breakpoints[underdog]["last_price"],
        "underdog_entry_ask": entry_asks[underdog],
        "underdog_bid_tp_breakpoints": bid_breakpoints[underdog]["tp"],
        "underdog_bid_sl_breakpoints": bid_breakpoints[underdog]["sl"],
        "underdog_last_bid": bid_breakpoints[underdog]["last_price"],
        "overdog_start_price": start_prices[overdog],
        "overdog_max_price": max_prices[overdog],
        "overdog_min_price": min_prices[overdog],
        "overdog_tp_breakpoints": breakpoints[overdog]["tp"],
        "overdog_sl_breakpoints": breakpoints[overdog]["sl"],
        "overdog_last_price": breakpoints[overdog]["last_price"],
        "overdog_entry_ask": entry_asks[overdog],
        "overdog_bid_tp_breakpoints": bid_breakpoints[overdog]["tp"],
        "overdog_bid_sl_breakpoints": bid_breakpoints[overdog]["sl"],
        "overdog_last_bid": bid_breakpoints[overdog]["last_price"],
        "volume_before_start": volume_before_start,
        "has_pandascore_start": find_match_start(event) is not None,
    }


_price_spike_stats_cache: list[dict] | None = None


def list_price_spike_stats() -> list[dict]:
    """Per-event underdog/overdog start price (at PandaScore match start, or
    2h-before-close as a fallback), max/min price from that point through the
    end of the candle data, and record-high/record-low breakpoints of the
    same window (see _running_extrema_breakpoints). Powers the analysis-page
    price-spike and EV-curve widgets. Cached in memory for the process
    lifetime, same operational model as candle_price_series and the
    pandascore match-start index."""
    global _price_spike_stats_cache
    if _price_spike_stats_cache is None:
        all_series = candle_price_series()
        stats = (_event_price_spike(event, all_series) for event in list_events())
        _price_spike_stats_cache = [stat for stat in stats if stat is not None]
    return _price_spike_stats_cache
