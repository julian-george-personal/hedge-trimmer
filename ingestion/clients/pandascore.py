import time
from pathlib import Path

import requests

from ingestion.config import load_config

BASE_URL = "https://api.pandascore.co"

CREDENTIALS_DIR = Path(__file__).resolve().parent.parent / "credentials" / "pandascore"
REQUEST_DELAY_SECONDS = load_config()["pandascore"]["request_delay_seconds"]


class PandaScoreClient:
    def __init__(self, token: str, base_url: str = BASE_URL):
        self.token = token
        self.base_url = base_url
        self.session = requests.Session()

    @classmethod
    def from_credentials_dir(cls, credentials_dir: Path = CREDENTIALS_DIR) -> "PandaScoreClient":
        token = (credentials_dir / "token.txt").read_text().strip()
        return cls(token=token)

    def get(self, path: str, params: dict | None = None) -> list | dict:
        time.sleep(REQUEST_DELAY_SECONDS)
        resp = self.session.get(self.base_url + path, params={**(params or {}), "token": self.token})
        resp.raise_for_status()
        return resp.json()
