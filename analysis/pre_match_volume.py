from analysis.data import candle_price_series, list_events
from analysis.match_timing import match_start_reference, volume_before


def _event_pre_match_volume(event: dict, all_series: dict[str, list[dict]]) -> float | None:
    series_by_market = [all_series.get(m["ticker"]) for m in event["markets"]]
    series_by_market = [series for series in series_by_market if series]
    if not series_by_market:
        return None

    ref_ts = match_start_reference(event)
    return sum(volume_before(series, ref_ts) for series in series_by_market)


_pre_match_volume_cache: dict[str, float] | None = None


def list_pre_match_volume() -> dict[str, float]:
    """Volume traded before each event's match-start reference time (see
    match_timing.match_start_reference), keyed by event_ticker. Powers the
    explorer's pre-match-volume filter. Cached in memory for the process
    lifetime, same operational model as candle_price_series."""
    global _pre_match_volume_cache
    if _pre_match_volume_cache is None:
        all_series = candle_price_series()
        volumes = {event["event_ticker"]: _event_pre_match_volume(event, all_series) for event in list_events()}
        _pre_match_volume_cache = {ticker: volume for ticker, volume in volumes.items() if volume is not None}
    return _pre_match_volume_cache
