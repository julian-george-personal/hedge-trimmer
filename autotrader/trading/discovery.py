import re
from datetime import datetime, timedelta, timezone

from autotrader.clients.kalshi import KalshiClient
from autotrader.clients.pandascore import PandaScoreClient

_NORMALIZE_RE = re.compile(r"[^a-z0-9]+")

# How far past the configured lead time to still look for a match's begin_at,
# so a slow poll tick doesn't miss a match whose window just opened.
DISCOVERY_WINDOW_BUFFER_MINUTES = 15


def normalize_team_name(name: str) -> str:
    return _NORMALIZE_RE.sub("", name.lower())


def _parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def group_kalshi_events(markets: list[dict]) -> list[dict]:
    events: dict[str, dict] = {}
    for market in markets:
        event = events.setdefault(
            market["event_ticker"],
            {"event_ticker": market["event_ticker"], "close_time": market["close_time"], "markets": []},
        )
        event["markets"].append({"ticker": market["ticker"], "team_name": market["yes_sub_title"]})
    return [event for event in events.values() if len(event["markets"]) == 2]


def _team_pair(event: dict) -> frozenset[str]:
    return frozenset(normalize_team_name(m["team_name"]) for m in event["markets"])


def _pandascore_team_pair(match: dict) -> frozenset[str] | None:
    names = [normalize_team_name(o["opponent"]["name"]) for o in match.get("opponents", []) if o.get("opponent")]
    return frozenset(names) if len(names) == 2 else None


def find_begin_at(event: dict, pandascore_matches: list[dict]) -> str | None:
    target_pair = _team_pair(event)
    close_time = _parse_iso(event["close_time"])
    candidates = [m for m in pandascore_matches if _pandascore_team_pair(m) == target_pair]
    if not candidates:
        return None
    closest = min(candidates, key=lambda m: abs(_parse_iso(m["begin_at"]) - close_time))
    return closest["begin_at"]


def is_within_entry_window(begin_at: str, now: datetime, lead_time_minutes: float) -> bool:
    """True once `now` has entered the lead-time window before the match's
    scheduled start, i.e. it's time to evaluate/enter — but not so far past
    start that entering would be pointless."""
    seconds_until_start = (_parse_iso(begin_at) - now).total_seconds()
    return 0 <= seconds_until_start <= lead_time_minutes * 60


def discover_candidates(
    kalshi_client: KalshiClient, pandascore_client: PandaScoreClient, series_ticker: str, lead_time_minutes: float
) -> list[dict]:
    """Upcoming Kalshi events (open KXCS2GAME markets) whose PandaScore
    begin_at has just entered the configured lead-time window — i.e. it's
    time to evaluate them against the trading filters."""
    now = datetime.now(timezone.utc)
    window_end = now + timedelta(minutes=lead_time_minutes + DISCOVERY_WINDOW_BUFFER_MINUTES)

    open_events = group_kalshi_events(kalshi_client.open_markets(series_ticker))
    upcoming_matches = pandascore_client.upcoming_cs2_matches(now, window_end)

    candidates = []
    for event in open_events:
        begin_at = find_begin_at(event, upcoming_matches)
        if begin_at and is_within_entry_window(begin_at, now, lead_time_minutes):
            candidates.append({**event, "begin_at": begin_at})
    return candidates
