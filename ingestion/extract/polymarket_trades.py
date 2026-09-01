import bisect

import requests

from ingestion.clients.polymarket import PolymarketClient

TRADE_PAGE_SIZE = 500


def fetch_trades(client: PolymarketClient, condition_id: str) -> list[dict]:
    """Raw trade prints for a market's whole lifetime, filtered by
    conditionId (the market-level 0x hash) — filtering by the per-outcome
    CLOB token id silently returns [] instead, a real gotcha confirmed during
    initial research (see project_polymarket_us_autotrading_scoping memory,
    same param mistake on a different Polymarket API). Paginates via offset;
    an empty page ends it cleanly.

    The endpoint has a hard, documented cap at offset=10000 ("max historical
    trades offset of 10000 exceeded", HTTP 400) — found live on a
    high-volume match. Trades are newest-first, so a market past the cap is
    missing its *oldest* trades, not its most recent — an honest, bounded
    under-count of pre-match volume for the small number of the very highest
    volume markets, not a crash that loses the entire market (price history
    included) the way letting this exception propagate would. Retrying
    wouldn't help — it's a permanent limit, not a transient failure."""
    trades: list[dict] = []
    offset = 0
    while True:
        try:
            page = client.get_data_api("/trades", params={"market": condition_id, "limit": TRADE_PAGE_SIZE, "offset": offset})
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 400:
                break
            raise
        if not page:
            break
        trades.extend(page)
        if len(page) < TRADE_PAGE_SIZE:
            break
        offset += TRADE_PAGE_SIZE
    return trades


def merge_trade_volume(candles: list[dict], trades: list[dict]) -> list[dict]:
    """Polymarket's /prices-history carries no volume of its own (see
    project_polymarket_ingestion_scoping memory) — this buckets each trade's
    raw share size into the candle whose timestamp is the latest one at or
    before the trade's, the same left-closed-interval convention a real OHLC
    candle's volume represents. Trades before the first candle (shouldn't
    normally happen, since both are fetched for the same market window) fall
    into that first candle rather than being silently dropped.

    Uses raw size, not notional (size * price): confirmed against a live
    market that Gamma's own reported `volume` field is an exact sum of trade
    sizes, not dollar notional (2271.2132380000003 == 2271.2132380000003) —
    matching that convention keeps this consistent with the volume figure
    already shown elsewhere (list_events' event/market volume, sourced
    directly from Gamma), rather than mixing two different units."""
    if not candles:
        return []
    times = [c["t"] for c in candles]
    volumes = [0.0] * len(candles)
    for trade in trades:
        idx = max(0, bisect.bisect_right(times, trade["timestamp"]) - 1)
        volumes[idx] += float(trade["size"])
    return [{**candle, "volume": volumes[i]} for i, candle in enumerate(candles)]
