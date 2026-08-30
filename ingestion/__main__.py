import logging
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.hazmat.primitives import serialization

from ingestion.clients.kalshi import KalshiClient
from ingestion.clients.pandascore import PandaScoreClient
from ingestion.scripts.ingest_pandascore import run as run_pandascore
from ingestion.scripts.ingest_series import run as run_series

logger = logging.getLogger("ingestion.scheduled")

REQUIRED_ENV_VARS = ["KALSHI_KEY_ID", "KALSHI_PRIVATE_KEY_PEM", "PANDASCORE_TOKEN"]

DATA_ROOT = "s3://hedge-trimmer-juliangeorge/kalshi"
PANDASCORE_DATA_ROOT = "s3://hedge-trimmer-juliangeorge/pandascore"

def _require_env() -> dict[str, str]:
    env = {name: os.environ.get(name) for name in REQUIRED_ENV_VARS}
    missing = [name for name, value in env.items() if not value]
    if missing:
        sys.exit(f"ingestion: missing required environment variables: {', '.join(missing)}")
    return env


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    env = _require_env()
    series_ticker = os.environ.get("KALSHI_SERIES_TICKER", "KXCS2GAME")
    window_days = int(os.environ.get("INGEST_WINDOW_DAYS", "3"))

    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=window_days)
    logger.info(
        "starting scheduled ingest: series_ticker=%s window=%s..%s",
        series_ticker,
        start_date.date(),
        end_date.date(),
    )

    kalshi_client = KalshiClient(
        key_id=env["KALSHI_KEY_ID"],
        private_key=serialization.load_pem_private_key(env["KALSHI_PRIVATE_KEY_PEM"].encode("utf-8"), password=None),
    )
    run_series(kalshi_client, series_ticker, start_date, end_date, DATA_ROOT, skip_existing_candles=True)

    pandascore_client = PandaScoreClient(token=env["PANDASCORE_TOKEN"])
    run_pandascore(pandascore_client, start_date, end_date, PANDASCORE_DATA_ROOT)

    logger.info("scheduled ingest complete")


if __name__ == "__main__":
    main()
