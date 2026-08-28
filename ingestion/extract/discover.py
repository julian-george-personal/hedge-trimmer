from ingestion.clients.kalshi import KalshiClient


def matches_keywords(keywords: tuple[str, ...], *fields: str) -> bool:
    text = " ".join(f for f in fields if f).lower()
    return any(kw in text for kw in keywords)


def fetch_all_series(client: KalshiClient) -> list[dict]:
    series: list[dict] = []
    cursor = None
    while True:
        params = {"cursor": cursor} if cursor else None
        resp = client.get("/series", params=params)
        page = resp.get("series", [])
        series.extend(page)
        cursor = resp.get("cursor")
        if not cursor or not page:
            break
    return series


def find_series(client: KalshiClient, keywords: tuple[str, ...]) -> list[dict]:
    all_series = fetch_all_series(client)
    return [
        s for s in all_series
        if matches_keywords(keywords, s.get("title", ""), " ".join(s.get("tags") or []))
    ]


def fetch_sample_markets(client: KalshiClient, series_ticker: str, limit: int = 10) -> list[dict]:
    resp = client.get("/markets", params={"series_ticker": series_ticker, "limit": limit})
    return resp.get("markets", [])
