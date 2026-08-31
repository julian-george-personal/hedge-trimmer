from ingestion.clients.polymarket import PolymarketClient

TAG_PAGE_SIZE = 100


def matches_keywords(keywords: tuple[str, ...], *fields: str) -> bool:
    text = " ".join(f for f in fields if f).lower()
    return any(kw in text for kw in keywords)


def fetch_all_tags(client: PolymarketClient) -> list[dict]:
    tags: list[dict] = []
    offset = 0
    while True:
        page = client.get_gamma("/tags", params={"limit": TAG_PAGE_SIZE, "offset": offset})
        tags.extend(page)
        if len(page) < TAG_PAGE_SIZE:
            break
        offset += TAG_PAGE_SIZE
    return tags


def find_tags(client: PolymarketClient, keywords: tuple[str, ...]) -> list[dict]:
    all_tags = fetch_all_tags(client)
    return [t for t in all_tags if matches_keywords(keywords, t.get("label", ""), t.get("slug", ""))]


def fetch_sample_events(client: PolymarketClient, tag_slug: str, limit: int = 10) -> list[dict]:
    return client.get_gamma("/events", params={"tag_slug": tag_slug, "limit": limit})
