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

SCAN_INTERVAL_SECONDS = 30
MONITOR_INTERVAL_SECONDS = 1

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

    def _act_on(self, result: MarketScanResult, config: TradingConfig) -> tuple[str, str | None]:
        """Attempts to enter a "passed" decision and reports what happened,
        rather than letting an order-placement failure propagate — a bare
        exception here would abort _record_decisions partway through a tick,
        silently skipping every other "passed" decision still left to record
        and act on that tick."""
        try:
            return enter_position(self.kalshi_client, self.store, result.event_ticker, result.to_filter_result(), config), None
        except Exception as exc:
            logger.exception("error entering position for %s", result.event_ticker)
            return "order_failed", str(exc)[:300]

    def _record_decisions(self, results: list[MarketScanResult], scanned_at: str, config: TradingConfig) -> list[MarketScanResult]:
        decisions = [r for r in results if r.status in _DECISION_STATUSES]
        for result in decisions:
            item = result.to_item(scanned_at)
            # Recorded on every decision (not just "passed") so the log is
            # self-explanatory later: a "passed" row logged while the trader
            # was stopped is expected to have no corresponding position.
            item["trader_enabled"] = config.enabled
            if config.enabled and result.status == "passed":
                action, error = self._act_on(result, config)
                item["action"] = action
                if error:
                    item["action_error"] = error
            self.store.put_market_scan(result.event_ticker, scanned_at, item)
        return decisions

    def _scan_and_act(self, config: TradingConfig) -> None:
        scanned_at = datetime.now(timezone.utc).isoformat()
        results = scan_markets(self.kalshi_client, self.pandascore_client, self.store, self.series_ticker, config)
        decisions = self._record_decisions(results, scanned_at, config)
        logger.info(
            "scanned %d open market(s), %d at decision point: %s",
            len(results), len(decisions), dict(Counter(r.status for r in decisions)),
        )

    def tick(self, run_scan: bool) -> None:
        """run_scan gates the (expensive, PandaScore-backed) entry scan to
        once every SCAN_INTERVAL_SECONDS, while exit checks — cheap, single
        Kalshi quote lookups per open position — run every tick so a
        stop-loss/take-profit is caught within MONITOR_INTERVAL_SECONDS of
        crossing, not up to SCAN_INTERVAL_SECONDS later. The summary log line
        is scan-gated too — logging it every MONITOR_INTERVAL_SECONDS would
        flood CloudWatch with an unchanged line once a second for as long as
        a position is open; exits already log themselves in monitor.py."""
        config = load_config(self.store)

        if run_scan:
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
        logger.info(
            "autotrader loop starting: scanning for entries every %ds, monitoring open positions every %ds",
            SCAN_INTERVAL_SECONDS, MONITOR_INTERVAL_SECONDS,
        )
        next_scan_at = time.monotonic()
        while True:
            run_scan = time.monotonic() >= next_scan_at
            try:
                self.tick(run_scan)
            except Exception:
                # A failure loading config (e.g. DynamoDB unreachable) would
                # otherwise be uncaught and silently kill this background
                # thread forever, while the web server keeps reporting
                # healthy — better to log and keep retrying every tick.
                logger.exception("unhandled error in autotrader loop tick")
            if run_scan:
                next_scan_at = time.monotonic() + SCAN_INTERVAL_SECONDS
            time.sleep(MONITOR_INTERVAL_SECONDS)
