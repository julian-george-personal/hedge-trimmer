from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from autotrader.clients.kalshi import KalshiClient
from autotrader.clients.pandascore import PandaScoreClient
from autotrader.storage.config import TradingConfig
from autotrader.storage.state import Store
from autotrader.trading.discovery import (
    DISCOVERY_WINDOW_BUFFER_MINUTES,
    find_begin_at,
    group_kalshi_events,
    is_within_entry_window,
    parse_iso,
)
from autotrader.trading.filters import FilterResult, evaluate_candidate


@dataclass
class MarketScanResult:
    event_ticker: str
    team_names: list[str]
    close_time: str
    begin_at: str | None
    status: str  # "passed" | "filtered" | "no_match" | "outside_window" | "already_positioned"
    reason: str | None
    side_ticker: str | None = None
    side_team_name: str | None = None
    entry_price_dollars: float | None = None
    win_prob_percent: float | None = None
    volume: float | None = None

    def to_item(self, scanned_at: str) -> dict:
        """DynamoDB-storable form: floats become Decimal (boto3's resource
        API rejects native float), same convention as TradingConfig.to_item."""
        item = {**asdict(self), "scanned_at": scanned_at}
        for key, value in item.items():
            if isinstance(value, float):
                item[key] = Decimal(str(value))
        return item

    def to_filter_result(self) -> FilterResult:
        """Reconstructs the passing FilterResult enter_position needs, so a
        market that passed during the scan doesn't need a second (and
        possibly quote-stale) live evaluation just to be acted on."""
        return FilterResult(
            passes=True,
            side_ticker=self.side_ticker,
            side_team_name=self.side_team_name,
            team_names=self.team_names,
            entry_price_dollars=self.entry_price_dollars,
            win_prob_percent=self.win_prob_percent,
            volume=self.volume,
        )


def _outside_window_reason(begin_at: str, now: datetime, lead_time_minutes: float) -> str:
    minutes_until_start = (parse_iso(begin_at) - now).total_seconds() / 60
    if minutes_until_start < 0:
        return "match has already started"
    return f"starts in {minutes_until_start:.0f} min, outside the {lead_time_minutes:.0f}-min lead-time window"


def scan_markets(
    kalshi_client: KalshiClient,
    pandascore_client: PandaScoreClient,
    store: Store,
    series_ticker: str,
    config: TradingConfig,
) -> list[MarketScanResult]:
    """Evaluates every currently open Kalshi event for the series against
    the current filters, not just ones that have already entered the
    lead-time window. This is the trader's actual per-tick decision pass —
    Runner.tick() persists every result (win, loss, or skip) so there's a
    full historical record of what the trader saw and why it acted or
    didn't, and acts on the ones that passed."""
    now = datetime.now(timezone.utc)
    window_end = now + timedelta(minutes=config.lead_time_minutes + DISCOVERY_WINDOW_BUFFER_MINUTES)

    open_events = group_kalshi_events(kalshi_client.open_markets(series_ticker))
    upcoming_matches = pandascore_client.upcoming_cs2_matches(now, window_end)

    results = []
    for event in open_events:
        team_names = [m["team_name"] for m in event["markets"]]
        event_ticker = event["event_ticker"]
        begin_at = find_begin_at(event, upcoming_matches)

        if not begin_at:
            results.append(MarketScanResult(
                event_ticker=event_ticker, team_names=team_names, close_time=event["close_time"], begin_at=None,
                status="no_match", reason="no PandaScore match found for this team pair within the discovery window",
            ))
            continue

        if not is_within_entry_window(begin_at, now, config.lead_time_minutes):
            results.append(MarketScanResult(
                event_ticker=event_ticker, team_names=team_names, close_time=event["close_time"], begin_at=begin_at,
                status="outside_window", reason=_outside_window_reason(begin_at, now, config.lead_time_minutes),
            ))
            continue

        if store.get_position(event_ticker) is not None:
            results.append(MarketScanResult(
                event_ticker=event_ticker, team_names=team_names, close_time=event["close_time"], begin_at=begin_at,
                status="already_positioned", reason="already have a position for this match",
            ))
            continue

        result = evaluate_candidate(kalshi_client, event, config)
        if result.passes:
            results.append(MarketScanResult(
                event_ticker=event_ticker, team_names=team_names, close_time=event["close_time"], begin_at=begin_at,
                status="passed", reason=None, side_ticker=result.side_ticker, side_team_name=result.side_team_name,
                entry_price_dollars=result.entry_price_dollars, win_prob_percent=result.win_prob_percent,
                volume=result.volume,
            ))
        else:
            results.append(MarketScanResult(
                event_ticker=event_ticker, team_names=team_names, close_time=event["close_time"], begin_at=begin_at,
                status="filtered", reason=result.reason,
            ))
    return results
