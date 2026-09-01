import time

import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry

from ingestion.config import load_config

GAMMA_BASE_URL = "https://gamma-api.polymarket.com"
CLOB_BASE_URL = "https://clob.polymarket.com"
DATA_API_BASE_URL = "https://data-api.polymarket.com"

REQUEST_DELAY_SECONDS = load_config()["polymarket"]["request_delay_seconds"]
REQUEST_TIMEOUT_SECONDS = 30


def _session_with_retries() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=5,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


class PolymarketClient:
    """Gamma (event/market discovery) + CLOB (price history) reads. Both are
    public and unauthenticated, unlike Kalshi's signed requests — no
    credentials or _sign/_auth_headers step needed."""

    def __init__(
        self,
        gamma_base_url: str = GAMMA_BASE_URL,
        clob_base_url: str = CLOB_BASE_URL,
        data_api_base_url: str = DATA_API_BASE_URL,
    ):
        self.gamma_base_url = gamma_base_url
        self.clob_base_url = clob_base_url
        self.data_api_base_url = data_api_base_url
        self.session = _session_with_retries()

    def _get(self, base_url: str, path: str, params: dict | None = None) -> dict | list:
        time.sleep(REQUEST_DELAY_SECONDS)
        resp = self.session.get(base_url + path, params=params, timeout=REQUEST_TIMEOUT_SECONDS)
        resp.raise_for_status()
        return resp.json()

    def get_gamma(self, path: str, params: dict | None = None) -> dict | list:
        return self._get(self.gamma_base_url, path, params)

    def get_clob(self, path: str, params: dict | None = None) -> dict | list:
        return self._get(self.clob_base_url, path, params)

    def get_data_api(self, path: str, params: dict | None = None) -> dict | list:
        return self._get(self.data_api_base_url, path, params)
