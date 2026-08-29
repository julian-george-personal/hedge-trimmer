import logging
import os
import sys
import threading

from autotrader.clients.kalshi import KalshiClient
from autotrader.clients.pandascore import PandaScoreClient
from autotrader.storage.state import Store
from autotrader.trading.loop import Runner
from autotrader.web.server import serve

REQUIRED_ENV_VARS = [
    "KALSHI_KEY_ID",
    "KALSHI_PRIVATE_KEY_PEM",
    "PANDASCORE_TOKEN",
    "BASIC_AUTH_USERNAME",
    "BASIC_AUTH_PASSWORD",
    "DYNAMO_TABLE_NAME",
]

def _require_env() -> dict[str, str]:
    env = {name: os.environ.get(name) for name in REQUIRED_ENV_VARS}
    missing = [name for name, value in env.items() if not value]
    if missing:
        sys.exit(f"autotrader: missing required environment variables: {', '.join(missing)}")
    return env

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    env = _require_env()
    series_ticker = os.environ.get("KALSHI_SERIES_TICKER", "KXCS2GAME")
    port = int(os.environ.get("PORT", "8080"))

    kalshi_client = KalshiClient(env["KALSHI_KEY_ID"], env["KALSHI_PRIVATE_KEY_PEM"])
    pandascore_client = PandaScoreClient(env["PANDASCORE_TOKEN"])
    store = Store(env["DYNAMO_TABLE_NAME"])

    runner = Runner(kalshi_client, pandascore_client, store, series_ticker)
    threading.Thread(target=runner.run, daemon=True, name="autotrader-loop").start()

    serve(store, env["BASIC_AUTH_USERNAME"], env["BASIC_AUTH_PASSWORD"], port)


if __name__ == "__main__":
    main()
