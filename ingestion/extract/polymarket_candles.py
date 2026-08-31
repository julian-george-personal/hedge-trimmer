import json

from ingestion.clients.polymarket import PolymarketClient

FIDELITY_MINUTES = 1

# CLOB's /prices-history silently coarsens to a handful of points when given
# an open-ended range (e.g. interval=max) instead of explicit startTs/endTs —
# passing explicit timestamps, chunked, is what actually gets ~1-minute
# fidelity all the way back through the platform's history.
MAX_CHUNK_SECONDS = 4000 * FIDELITY_MINUTES * 60


def market_price_token(market: dict) -> str:
    """Both of a binary market's two CLOB tokens move as complements of each
    other, so only the first (index 0, matching outcomes[0]) needs fetching —
    same one-request-per-market shape as Kalshi's candlesticks call, just
    without a separate yes_bid/yes_ask leg since Polymarket doesn't expose
    historical bid/ask (see project_polymarket_ingestion_scoping memory)."""
    return json.loads(market["clobTokenIds"])[0]


def _fetch_price_history_chunk(client: PolymarketClient, token_id: str, start_ts: int, end_ts: int) -> list[dict]:
    resp = client.get_clob(
        "/prices-history",
        params={"market": token_id, "startTs": start_ts, "endTs": end_ts, "fidelity": FIDELITY_MINUTES},
    )
    return resp.get("history", [])


def fetch_price_history(client: PolymarketClient, token_id: str, start_ts: int, end_ts: int) -> list[dict]:
    points = []
    seen_ts = set()
    chunk_start = start_ts
    while chunk_start < end_ts:
        chunk_end = min(chunk_start + MAX_CHUNK_SECONDS, end_ts)
        for point in _fetch_price_history_chunk(client, token_id, chunk_start, chunk_end):
            if point["t"] in seen_ts:
                continue
            seen_ts.add(point["t"])
            points.append(point)
        chunk_start = chunk_end
    return points
