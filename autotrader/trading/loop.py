import logging
import time
from collections import Counter
from datetime import datetime, timezone

from autotrader.clients.kalshi import KalshiClient
from autotrader.clients.pandascore import PandaScoreClient
from autotrader.storage.config import TradingConfig, load_config
from autotrader.storage.state import Store
from autotrader.trading.execution import enter_position
from autotrader.trading.market_scan import MarketScanResult, scan_markets
from autotrader.trading.monitor import check_open_positions

logger = logging.getLogger("autotrader.loop")

POLL_INTERVAL_SECONDS = 30

# The only statuses that represent the trader actually reaching a betting
# decision for a match (i.e. it's entered the lead-time window). "no_match"
# and "outside_window" just mean "not yet time to decide" — recording those
# every tick for as long as a market's been open would flood the history
# with the same non-decision for hours before it ever becomes relevant.
_DECISION_STATUSES = {"passed", "filtered", "already_positioned"}


class Runner:
    def __init__(self, kalshi_client: KalshiClient, pandascore_client: PandaScoreClient, store: Store, series_ticker: str):
        self.kalshi_client = kalshi_client
        self.pandascore_client = pandascore_client
        self.store = store
        self.series_ticker = series_ticker

    def _record_decisions(self, results: list[MarketScanResult], scanned_at: str) -> list[MarketScanResult]:
        decisions = [r for r in results if r.status in _DECISION_STATUSES]
        for result in decisions:
            self.store.put_market_scan(result.event_ticker, scanned_at, result.to_item(scanned_at))
        return decisions

    def _scan_and_act(self, config: TradingConfig) -> None:
        scanned_at = datetime.now(timezone.utc).isoformat()
        results = scan_markets(self.kalshi_client, self.pandascore_client, self.store, self.series_ticker, config)
        decisions = self._record_decisions(results, scanned_at)
        logger.info(
            "scanned %d open market(s), %d at decision point: %s",
            len(results), len(decisions), dict(Counter(r.status for r in decisions)),
        )

        if not config.enabled:
            return
        for result in decisions:
            if result.status == "passed":
                enter_position(self.kalshi_client, self.store, result.event_ticker, result.to_filter_result(), config)

    def tick(self) -> None:
        config = load_config(self.store)
        open_positions = self.store.list_open_positions()
        logger.info(
            "tick: enabled=%s armed=%s side=%s open_positions=%d",
            config.enabled, config.armed, config.side, len(open_positions),
        )

        try:
            self._scan_and_act(config)
        except Exception:
            logger.exception("error while scanning for new matches to enter")

        try:
            check_open_positions(self.kalshi_client, self.store, config)
        except Exception:
            logger.exception("error while checking open positions for exit")

    def run(self) -> None:
        logger.info("autotrader loop starting, polling every %ds", POLL_INTERVAL_SECONDS)
        while True:
            try:
                self.tick()
            except Exception:
                # A failure loading config (e.g. DynamoDB unreachable) would
                # otherwise be uncaught and silently kill this background
                # thread forever, while the web server keeps reporting
                # healthy — better to log and keep retrying every tick.
                logger.exception("unhandled error in autotrader loop tick")
            time.sleep(POLL_INTERVAL_SECONDS)
