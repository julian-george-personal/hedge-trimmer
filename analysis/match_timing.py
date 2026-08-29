from datetime import datetime

from analysis.pandascore import find_match_start

# When PandaScore has no matching match record, fall back to this many
# seconds before the market closed as the "match start" reference point —
# mirrors the chart's default-zoom fallback in explorer.js.
MATCH_START_FALLBACK_SECONDS = 2 * 60 * 60


def epoch_seconds(iso_ts: str) -> int:
    return int(datetime.fromisoformat(iso_ts.replace("Z", "+00:00")).timestamp())


def match_start_reference(event: dict) -> int:
    """Epoch seconds for judging pre/post match-start: the PandaScore
    begin_at when found, else MATCH_START_FALLBACK_SECONDS before the market
    closed."""
    begin_at = find_match_start(event)
    if begin_at:
        return epoch_seconds(begin_at)
    return epoch_seconds(event["close_time"]) - MATCH_START_FALLBACK_SECONDS


def volume_before(series: list[dict], target_ts: int) -> float:
    return sum(point["volume"] for point in series if point["t"] < target_ts)
