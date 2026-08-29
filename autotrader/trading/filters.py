from dataclasses import dataclass

from autotrader.clients.kalshi import KalshiClient
from autotrader.storage.config import TradingConfig


@dataclass
class FilterResult:
    passes: bool
    side_ticker: str | None = None
    side_team_name: str | None = None
    entry_price_dollars: float | None = None
    win_prob_percent: float | None = None
    volume: float | None = None
    reason: str | None = None


def quote_price_dollars(market: dict) -> float | None:
    """Current mid price if there's a live two-sided quote, else the last
    traded price as a fallback — same precedence as the backtester's
    ask/bid-aware fields, adapted to a single live snapshot rather than a
    historical candle series."""
    yes_bid, yes_ask = market.get("yes_bid"), market.get("yes_ask")
    if yes_bid is not None and yes_ask is not None and (yes_bid > 0 or yes_ask > 0):
        return ((yes_bid + yes_ask) / 2) / 100
    last_price = market.get("last_price")
    return (last_price / 100) if last_price else None


def _assign_side(candidate: dict, prices: list[float], side: str) -> int:
    underdog_index = 0 if prices[0] < prices[1] else 1
    overdog_index = 1 - underdog_index
    return underdog_index if side == "underdog" else overdog_index


def evaluate_candidate(kalshi_client: KalshiClient, candidate: dict, config: TradingConfig) -> FilterResult:
    """Fetches live quotes for both sides of a candidate event and checks
    them against the configured side/volume/win-prob filters. `win_prob` is
    the chosen side's current price used as the live proxy for "win
    probability at start" (the backtester's `${side}_start_price * 100`),
    since the real match hasn't started yet at decision time."""
    markets = [kalshi_client.get_market(m["ticker"]) for m in candidate["markets"]]
    prices = [quote_price_dollars(m) for m in markets]
    if None in prices or prices[0] == prices[1]:
        return FilterResult(passes=False, reason="missing or tied quote")

    side_index = _assign_side(candidate, prices, config.side)
    entry_price = prices[side_index]
    win_prob_percent = entry_price * 100
    volume = sum(m.get("volume") or 0 for m in markets)

    if not (config.pre_match_volume_min <= volume <= config.pre_match_volume_max):
        return FilterResult(
            passes=False,
            reason=f"volume {volume:.0f} outside configured range [{config.pre_match_volume_min:.0f}, {config.pre_match_volume_max:.0f}]",
        )
    if not (config.win_prob_min <= win_prob_percent <= config.win_prob_max):
        return FilterResult(
            passes=False,
            reason=f"win prob {win_prob_percent:.1f}% outside configured range [{config.win_prob_min:.1f}%, {config.win_prob_max:.1f}%]",
        )

    side_market = candidate["markets"][side_index]
    return FilterResult(
        passes=True,
        side_ticker=side_market["ticker"],
        side_team_name=side_market["team_name"],
        entry_price_dollars=entry_price,
        win_prob_percent=win_prob_percent,
        volume=volume,
    )
