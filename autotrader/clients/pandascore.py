from datetime import datetime

import requests

BASE_URL = "https://api.pandascore.co"
CS2_VIDEOGAME_TITLE = "cs-2"
PER_PAGE = 100
REQUEST_TIMEOUT_SECONDS = 30


class PandaScoreClient:
    """Standalone minimal PandaScore client for the autotrader service.
    Deliberately not shared with ingestion.clients.pandascore."""

    def __init__(self, token: str, base_url: str = BASE_URL):
        self.token = token
        self.base_url = base_url
        self.session = requests.Session()

    def get(self, path: str, params: dict | None = None) -> list | dict:
        resp = self.session.get(
            self.base_url + path, params={**(params or {}), "token": self.token}, timeout=REQUEST_TIMEOUT_SECONDS
        )
        resp.raise_for_status()
        return resp.json()

    def upcoming_cs2_matches(self, from_time: datetime, to_time: datetime) -> list[dict]:
        matches: list[dict] = []
        page = 1
        while True:
            batch = self.get(
                "/csgo/matches",
                params={
                    "filter[videogame_title]": CS2_VIDEOGAME_TITLE,
                    "range[begin_at]": f"{from_time.isoformat()},{to_time.isoformat()}",
                    "sort": "begin_at",
                    "per_page": PER_PAGE,
                    "page": page,
                },
            )
            matches.extend(batch)
            if len(batch) < PER_PAGE:
                break
            page += 1
        return matches
