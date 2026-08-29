import logging
from datetime import datetime, timezone
from decimal import Decimal

from autotrader.clients.kalshi import KalshiClient
from autotrader.storage.config import TradingConfig
from autotrader.storage.state import Store
from autotrader.trading.filters import FilterResult

logger = logging.getLogger("autotrader.execution")

# Marketable-limit buffer: a limit buy priced a couple cents past the current
# ask still fills immediately against the book (unlike a limit right at the
# ask, which can sit unfilled through a one-tick move) while still bounding
# the worst possible fill price, unlike a true market order.
SLIPPAGE_CENTS = 2


def _entry_limit_price_cents(ask_dollars: float) -> int:
    return max(1, min(99, round(ask_dollars * 100) + SLIPPAGE_CENTS))


def _place_entry_order(kalshi_client: KalshiClient, result: FilterResult, contracts: int, order_style: str) -> dict:
    if order_style == "limit":
        market = kalshi_client.get_market(result.side_ticker)
        price_cents = _entry_limit_price_cents(float(market["yes_ask_dollars"]))
        return kalshi_client.create_order(result.side_ticker, "yes", "buy", contracts, "limit", price_cents)
    return kalshi_client.create_order(result.side_ticker, "yes", "buy", contracts, "market")


def enter_position(
    kalshi_client: KalshiClient, store: Store, event_ticker: str, result: FilterResult, config: TradingConfig
) -> str:
    """Returns "entered" or "skipped_too_small" so the caller can record why
    a "passed" decision didn't produce a position — an unhandled exception
    (order placement failure) is the third case, left to propagate."""
    contracts = int(config.bet_per_match_dollars // result.entry_price_dollars)
    if contracts < 1:
        logger.warning("skip %s: bet size $%.2f too small at entry price $%.2f", event_ticker, config.bet_per_match_dollars, result.entry_price_dollars)
        return "skipped_too_small"

    order_id = None
    if config.armed:
        order = _place_entry_order(kalshi_client, result, contracts, config.order_style)
        order_id = order.get("order_id")
        logger.info(
            "ENTERED %s: %d contracts of %s (~$%.2f each), order %s",
            event_ticker, contracts, result.side_ticker, result.entry_price_dollars, order_id,
        )
    else:
        logger.info(
            "DRY RUN entry %s: would buy %d contracts of %s at ~$%.2f",
            event_ticker, contracts, result.side_ticker, result.entry_price_dollars,
        )

    store.put_position(
        event_ticker,
        {
            "status": "open",
            "ticker": result.side_ticker,
            "team_name": result.side_team_name,
            "entry_price_dollars": Decimal(str(result.entry_price_dollars)),
            "contracts": contracts,
            "entry_time": datetime.now(timezone.utc).isoformat(),
            "dry_run": not config.armed,
            "order_id": order_id,
        },
    )
    return "entered"
