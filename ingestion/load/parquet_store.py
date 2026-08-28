from pathlib import Path

import pandas as pd

DEFAULT_DATA_ROOT = str(Path(__file__).resolve().parent.parent / "data" / "raw" / "kalshi")
DEFAULT_PANDASCORE_DATA_ROOT = str(Path(__file__).resolve().parent.parent / "data" / "raw" / "pandascore")


def _is_local(data_root: str) -> bool:
    return not data_root.startswith("s3://")


def _write_parquet(records: list[dict], data_root: str, *path_parts: str) -> str:
    out_path = "/".join([data_root.rstrip("/"), *path_parts])
    if _is_local(data_root):
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    pd.json_normalize(records).to_parquet(out_path, index=False)
    return out_path


def write_markets(markets: list[dict], series_ticker: str, data_root: str = DEFAULT_DATA_ROOT) -> str:
    return _write_parquet(markets, data_root, "markets", f"series={series_ticker}", "markets.parquet")


def write_candles(candles: list[dict], ticker: str, data_root: str = DEFAULT_DATA_ROOT) -> str:
    return _write_parquet(candles, data_root, "candles", f"ticker={ticker}", "candles.parquet")


def write_pandascore_matches(matches: list[dict], data_root: str = DEFAULT_PANDASCORE_DATA_ROOT) -> str:
    return _write_parquet(matches, data_root, "matches.parquet")
