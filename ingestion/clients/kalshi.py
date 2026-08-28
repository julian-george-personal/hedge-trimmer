import base64
import time
from pathlib import Path

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from ingestion.config import load_config

BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
API_PREFIX = "/trade-api/v2"

CREDENTIALS_DIR = Path(__file__).resolve().parent.parent / "credentials" / "kalshi"
REQUEST_DELAY_SECONDS = load_config()["kalshi"]["request_delay_seconds"]


class KalshiClient:
    def __init__(self, key_id: str, private_key, base_url: str = BASE_URL):
        self.key_id = key_id
        self.private_key = private_key
        self.base_url = base_url
        self.session = requests.Session()

    @classmethod
    def from_credentials_dir(cls, credentials_dir: Path = CREDENTIALS_DIR) -> "KalshiClient":
        key_id = (credentials_dir / "key_id.txt").read_text().strip()
        private_key = serialization.load_pem_private_key(
            (credentials_dir / "private_key.pem").read_bytes(), password=None
        )
        return cls(key_id=key_id, private_key=private_key)

    def _sign(self, timestamp_ms: str, method: str, path: str) -> str:
        message = f"{timestamp_ms}{method}{path}".encode("utf-8")
        signature = self.private_key.sign(
            message,
            padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
            hashes.SHA256(),
        )
        return base64.b64encode(signature).decode("utf-8")

    def _auth_headers(self, method: str, path: str) -> dict:
        timestamp_ms = str(int(time.time() * 1000))
        return {
            "KALSHI-ACCESS-KEY": self.key_id,
            "KALSHI-ACCESS-SIGNATURE": self._sign(timestamp_ms, method, path),
            "KALSHI-ACCESS-TIMESTAMP": timestamp_ms,
        }

    def get(self, path: str, params: dict | None = None) -> dict:
        full_path = API_PREFIX + path
        headers = self._auth_headers("GET", full_path)
        time.sleep(REQUEST_DELAY_SECONDS)
        resp = self.session.get(self.base_url + path, headers=headers, params=params)
        resp.raise_for_status()
        return resp.json()
