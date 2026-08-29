import logging
import time

from autotrader.clients.kalshi import KalshiClient
from autotrader.clients.pandascore import PandaScoreClient
from autotrader.storage.config import load_config
from autotrader.storage.state import Store
from autotrader.trading.discovery import discover_candidates
from autotrader.trading.execution import enter_position
from autotrader.trading.filters import evaluate_candidate
from autotrader.trading.monitor import check_open_positions

logger = logging.getLogger("autotrader.loop")

POLL_INTERVAL_SECONDS = 30


class Runner:
    def __init__(self, kalshi_client: KalshiClient, pandascore_client: PandaScoreClient, store: Store, series_ticker: str):
        self.kalshi_client = kalshi_client
        self.pandascore_client = pandascore_client
        self.store = store
        self.series_ticker = series_ticker

    def _try_enter_new_positions(self, config) -> None:
        candidates = discover_candidates(self.kalshi_client, self.pandascore_client, self.series_ticker, config.lead_time_minutes)
        logger.info("discovered %d candidate match(es) within the lead-time window", len(candidates))
        for candidate in candidates:
            event_ticker = candidate["event_ticker"]
            if self.store.get_position(event_ticker) is not None:
                continue  # already acted on this match

            result = evaluate_candidate(self.kalshi_client, candidate, config)
            if not result.passes:
                logger.info("skip %s: %s", event_ticker, result.reason)
                continue

            enter_position(self.kalshi_client, self.store, event_ticker, result, config)

    def tick(self) -> None:
        config = load_config(self.store)
        open_positions = self.store.list_open_positions()
        logger.info(
            "tick: enabled=%s armed=%s side=%s open_positions=%d",
            config.enabled, config.armed, config.side, len(open_positions),
        )

        if config.enabled:
            try:
                self._try_enter_new_positions(config)
            except Exception:
                logger.exception("error while looking for new matches to enter")

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
