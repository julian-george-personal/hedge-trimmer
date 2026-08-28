from datetime import datetime

from ingestion.clients.pandascore import PandaScoreClient

CS2_VIDEOGAME_TITLE = "cs-2"
PER_PAGE = 100


def fetch_cs2_matches(client: PandaScoreClient, from_time: datetime, to_time: datetime) -> list[dict]:
    matches: list[dict] = []
    page = 1
    while True:
        batch = client.get(
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
