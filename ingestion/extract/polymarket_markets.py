import json
import time
from datetime import datetime, timedelta, timezone

from ingestion.clients.polymarket import PolymarketClient

EVENT_PAGE_SIZE = 100

# Gamma's /events DOES filter server-side on start_date_min/start_date_max —
# but only as bare YYYY-MM-DD dates; the same params with a full ISO
# timestamp (e.g. "2025-12-01T00:00:00Z") are silently ignored, which is what
# made this look broken in earlier testing (see project_polymarket_ingestion
# _scoping memory — needs correcting there too). Without this filter, /events
# pages newest-first with no way to skip straight to an old date, so a query
# for months-old history has to page through every event back to today first
# — that's what was actually causing the offset=2100 422s, not "querying too
# large a single window" as first suspected.
#
# Still chunked by week (not sent as one multi-month query) because the
# filtered result set itself can exceed Gamma's pagination-depth limit over a
# long enough range (~70 events/day observed recently * 30 days ≈ 2100,
# right at the wall) — a week keeps every chunk comfortably under it even if
# density triples.
DISCOVERY_WINDOW_DAYS = 7
WINDOW_RETRY_ATTEMPTS = 3
WINDOW_RETRY_BACKOFF_SECONDS = 5


def _fetch_closed_events_window(client: PolymarketClient, tag_slug: str, start_date_min: str, start_date_max: str) -> list[dict]:
    events: list[dict] = []
    offset = 0
    while True:
        page = client.get_gamma(
            "/events",
            params={
                "tag_slug": tag_slug,
                "closed": "true",
                "start_date_min": start_date_min,
                "start_date_max": start_date_max,
                "limit": EVENT_PAGE_SIZE,
                "offset": offset,
            },
        )
        if not page:
            break
        events.extend(page)
        if len(page) < EVENT_PAGE_SIZE:
            break
        offset += EVENT_PAGE_SIZE
    return events


def fetch_closed_events(client: PolymarketClient, tag_slug: str, min_start_ts: int, max_start_ts: int) -> list[dict]:
    events: list[dict] = []
    window_start = datetime.fromtimestamp(min_start_ts, tz=timezone.utc).date()
    end = datetime.fromtimestamp(max_start_ts, tz=timezone.utc).date()
    while window_start <= end:
        window_end = min(window_start + timedelta(days=DISCOVERY_WINDOW_DAYS), end + timedelta(days=1))
        for attempt in range(1, WINDOW_RETRY_ATTEMPTS + 1):
            try:
                events.extend(
                    _fetch_closed_events_window(client, tag_slug, window_start.isoformat(), window_end.isoformat())
                )
                break
            except Exception as exc:
                if attempt == WINDOW_RETRY_ATTEMPTS:
                    print(f"  discovery window {window_start}-{window_end}: FAILED after {attempt} attempts ({exc})")
                else:
                    time.sleep(WINDOW_RETRY_BACKOFF_SECONDS * attempt)
        window_start = window_end
    return events


def _is_match_moneyline(market: dict, markets_in_event: int) -> bool:
    """True for the single market equivalent to a Kalshi ticker (the overall
    match winner) among an event's markets, which otherwise also include
    per-map winners, handicaps, and totals with no primary-market marker of
    their own. Gamma tags each with sportsMarketType ("moneyline",
    "child_moneyline" for per-map, "totals", "map_handicap", etc) on events
    built with the newer sportsbook-style props — confirmed absent (None) on
    older events, which instead carry exactly one market per event with
    nothing else to disambiguate it from, and also on tournament-outright
    events ("Will X win the tournament?", one Yes/No market per team, no
    single winner-take-all market to flag).

    The single-market fallback also wrongly caught single-market Yes/No
    futures/prop questions under the same tag ("Will Team Falcons win an S
    tier event in 2026?", "Will BC.Game make a roster move before May?") —
    found live in a full backfill: these run for months (one had 199,549
    ingested price points, ~138 days at 1-minute fidelity) rather than a
    match's few hours, both wasting massive ingestion time and polluting the
    explorer with nonsense "matches" between teams named "Yes" and "No".
    Every genuine head-to-head market's outcomes are the two real team
    names; a literal ["Yes", "No"] pair is never one, so it's excluded here
    even when markets_in_event == 1."""
    sports_market_type = market.get("sportsMarketType")
    if sports_market_type is not None:
        return sports_market_type == "moneyline"
    if markets_in_event != 1:
        return False
    outcomes = json.loads(market.get("outcomes") or "[]")
    return [o.strip().lower() for o in outcomes] != ["yes", "no"]


def flatten_markets(events: list[dict]) -> list[dict]:
    """One row per Polymarket market (moneyline, per-map winner, handicap, totals,
    etc — Polymarket doesn't distinguish a "primary" market the way a Kalshi series
    has one ticker per game), annotated with its parent event's identifiers so
    markets can be grouped back into events downstream, same role as Kalshi's
    native event_ticker field on each market."""
    markets: list[dict] = []
    for event in events:
        event_markets = event.get("markets", [])
        for market in event_markets:
            markets.append(
                {
                    **market,
                    "event_id": event["id"],
                    "event_slug": event["slug"],
                    "event_title": event["title"],
                    "is_match_moneyline": _is_match_moneyline(market, len(event_markets)),
                }
            )
    return markets


def fetch_closed_markets(client: PolymarketClient, tag_slug: str, min_start_ts: int, max_start_ts: int) -> list[dict]:
    events = fetch_closed_events(client, tag_slug, min_start_ts, max_start_ts)
    return flatten_markets(events)
