import logging
from datetime import datetime, timezone
from decimal import Decimal

from autotrader.clients.kalshi import KalshiClient
from autotrader.storage.config import TradingConfig
from autotrader.storage.state import Store
from autotrader.trading.filters import exit_quote_price_dollars

logger = logging.getLogger("autotrader.monitor")

SLIPPAGE_CENTS = 2  # marketable-limit buffer below the current bid, mirrors execution.py's entry buffer


def _exit_limit_price_cents(bid_dollars: float) -> int:
    return max(1, min(99, round(bid_dollars * 100) - SLIPPAGE_CENTS))


def _exit_reason(entry_price: float, current_price: float, config: TradingConfig) -> str | None:
    """stop_loss_percent/take_profit_percent are both expressed as % of the
    entry price: a take-profit of 125 means "exit once price reaches 225% of
    entry" (a +125% gain), a stop-loss of 40 means "exit once price falls to
    40% of entry" — matching the screenshot's "+125%" / "40% of start price"
    framing."""
    take_profit_price = entry_price * (1 + config.take_profit_percent / 100)
    if current_price >= take_profit_price:
        return "take_profit"
    if config.stop_loss_percent > 0:
        stop_loss_price = entry_price * (config.stop_loss_percent / 100)
        if current_price <= stop_loss_price:
            return "stop_loss"
    return None


def _place_exit_order(kalshi_client: KalshiClient, ticker: str, contracts: int, order_style: str) -> dict:
    if order_style == "limit":
        market = kalshi_client.get_market(ticker)
        price_cents = _exit_limit_price_cents(float(market["yes_bid_dollars"]))
        return kalshi_client.create_order(ticker, "yes", "sell", contracts, "limit", price_cents)
    return kalshi_client.create_order(ticker, "yes", "sell", contracts, "market")


def _record_close(
    store: Store, event_ticker: str, position: dict, exit_price: float, reason: str, order_id: str | None
) -> None:
    store.put_position(
        event_ticker,
        {
            **position,
            "status": "closed",
            "exit_reason": reason,
            "exit_price_dollars": Decimal(str(exit_price)),
            "exit_time": datetime.now(timezone.utc).isoformat(),
            "exit_order_id": order_id,
        },
    )


def _close_position(
    kalshi_client: KalshiClient, store: Store, event_ticker: str, position: dict, current_price: float, reason: str, order_style: str
) -> None:
    order_id = None
    if not position.get("dry_run", True):
        order = _place_exit_order(kalshi_client, position["ticker"], int(position["contracts"]), order_style)
        order_id = order.get("order_id")
        logger.info("EXITED %s (%s): %s at ~$%.2f, order %s", event_ticker, reason, position["ticker"], current_price, order_id)
    else:
        logger.info("DRY RUN exit %s (%s): %s at ~$%.2f", event_ticker, reason, position["ticker"], current_price)

    _record_close(store, event_ticker, position, current_price, reason, order_id)


def _close_settled_position(store: Store, event_ticker: str, position: dict, market: dict) -> None:
    """Once a market finalizes, its order book empties out (yes_bid=0,
    yes_ask=1) and exit_quote_price_dollars falls back to whatever the last
    trade happened to be before resolution — not necessarily the actual
    settlement outcome — so a position left open through settlement would
    otherwise sit "open" in the store forever, even though Kalshi has
    already auto-settled and paid it out (win or loss, no sell order needed
    or possible on a finalized market)."""
    settlement_price = float(market["settlement_value_dollars"])
    logger.info(
        "SETTLED %s: %s resolved %s, settled at $%.2f", event_ticker, position["ticker"], market.get("result"), settlement_price
    )
    _record_close(store, event_ticker, position, settlement_price, "settled", None)


def check_open_positions(kalshi_client: KalshiClient, store: Store, config: TradingConfig) -> None:
    """Runs on every loop tick regardless of `enabled` — stopping the trader
    only pauses new entries, it never abandons a position already at risk."""
    for position in store.list_open_positions():
        event_ticker = position["PK"].removeprefix("POSITION#")
        market = kalshi_client.get_market(position["ticker"])

        if market.get("result"):
            _close_settled_position(store, event_ticker, position, market)
            continue

        current_price = exit_quote_price_dollars(market)
        if current_price is None:
            continue

        reason = _exit_reason(float(position["entry_price_dollars"]), current_price, config)
        if reason:
            _close_position(kalshi_client, store, event_ticker, position, current_price, reason, config.order_style)
