import time
from datetime import datetime

from ingestion.clients.polymarket import PolymarketClient

EVENT_PAGE_SIZE = 100

# Gamma's /events 422s once offset gets deep enough (observed failure at
# offset=2100 querying an 11-month window in one go) — some undocumented
# pagination-depth limit, not a rate limit. Querying in day-sized windows
# instead keeps each query's page count small (a busy day is ~600-700 events
# across all tag_slug=counter-strike-2 markets, ~6-7 pages) and comfortably
# under that limit, at the cost of more (cheap, discovery-only) requests.
DISCOVERY_WINDOW_SECONDS = 24 * 60 * 60
WINDOW_RETRY_ATTEMPTS = 3
WINDOW_RETRY_BACKOFF_SECONDS = 5


def _parse_ts(iso_string: str) -> int:
    return int(datetime.fromisoformat(iso_string.replace("Z", "+00:00")).timestamp())


def _fetch_closed_events_window(
    client: PolymarketClient, tag_slug: str, min_start_ts: int, max_start_ts: int
) -> list[dict]:
    """Gamma's /events has no working server-side date-range filter (startDateMin/Max
    and start_date_min/max are both silently ignored), so this pages newest-first and
    stops once a page's events fall entirely before min_start_ts — the client-side
    equivalent of Kalshi's server-side min_close_ts/max_close_ts filtering. Callers
    keep [min_start_ts, max_start_ts) narrow (see DISCOVERY_WINDOW_SECONDS) to avoid
    Gamma's pagination-depth limit."""
    events: list[dict] = []
    offset = 0
    while True:
        page = client.get_gamma(
            "/events",
            params={
                "tag_slug": tag_slug,
                "closed": "true",
                "limit": EVENT_PAGE_SIZE,
                "offset": offset,
                "order": "startDate",
                "ascending": "false",
            },
        )
        if not page:
            break

        page_had_in_range = False
        for event in page:
            start_ts = _parse_ts(event["startDate"])
            if start_ts < min_start_ts:
                continue
            page_had_in_range = True
            if start_ts <= max_start_ts:
                events.append(event)

        if not page_had_in_range:
            break
        offset += EVENT_PAGE_SIZE
    return events


def fetch_closed_events(client: PolymarketClient, tag_slug: str, min_start_ts: int, max_start_ts: int) -> list[dict]:
    events: list[dict] = []
    window_start = min_start_ts
    while window_start < max_start_ts:
        window_end = min(window_start + DISCOVERY_WINDOW_SECONDS, max_start_ts)
        for attempt in range(1, WINDOW_RETRY_ATTEMPTS + 1):
            try:
                events.extend(_fetch_closed_events_window(client, tag_slug, window_start, window_end))
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
    single winner-take-all market to flag)."""
    sports_market_type = market.get("sportsMarketType")
    if sports_market_type is not None:
        return sports_market_type == "moneyline"
    return markets_in_event == 1


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
