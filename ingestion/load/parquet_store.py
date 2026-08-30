from pathlib import Path

import pandas as pd

DEFAULT_DATA_ROOT = str(Path(__file__).resolve().parent.parent / "data" / "raw" / "kalshi")
DEFAULT_PANDASCORE_DATA_ROOT = str(Path(__file__).resolve().parent.parent / "data" / "raw" / "pandascore")


def _is_local(data_root: str) -> bool:
    return not data_root.startswith("s3://")


def _out_path(data_root: str, *path_parts: str) -> str:
    return "/".join([data_root.rstrip("/"), *path_parts])


def _path_exists(path: str) -> bool:
    if _is_local(path):
        return Path(path).exists()
    import s3fs

    return s3fs.S3FileSystem().exists(path)


def _write_parquet(records: list[dict], data_root: str, *path_parts: str) -> str:
    out_path = _out_path(data_root, *path_parts)
    if _is_local(data_root):
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    pd.json_normalize(records).to_parquet(out_path, index=False)
    return out_path


def _merge_and_write_parquet(
    records: list[dict], key: str, overwrite: bool, data_root: str, *path_parts: str
) -> str:
    """Like _write_parquet, but by default merges with whatever's already at
    out_path instead of overwriting it — callers (markets, pandascore matches)
    write the same file on every run, so a scheduled job re-querying only a
    recent window would otherwise silently delete all older history each time
    it runs. Pass overwrite=True to force a full replace instead (e.g. a
    deliberate backfill re-run)."""
    out_path = _out_path(data_root, *path_parts)
    new_df = pd.json_normalize(records)
    if not overwrite and _path_exists(out_path):
        existing_df = pd.read_parquet(out_path)
        new_df = pd.concat([existing_df, new_df], ignore_index=True).drop_duplicates(subset=key, keep="last")
    if _is_local(data_root):
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    new_df.to_parquet(out_path, index=False)
    return out_path


def write_markets(
    markets: list[dict], series_ticker: str, data_root: str = DEFAULT_DATA_ROOT, overwrite: bool = False
) -> str:
    return _merge_and_write_parquet(
        markets, "ticker", overwrite, data_root, "markets", f"series={series_ticker}", "markets.parquet"
    )


def candles_exist(ticker: str, data_root: str = DEFAULT_DATA_ROOT) -> bool:
    return _path_exists(_out_path(data_root, "candles", f"ticker={ticker}", "candles.parquet"))


def write_candles(candles: list[dict], ticker: str, data_root: str = DEFAULT_DATA_ROOT) -> str:
    return _write_parquet(candles, data_root, "candles", f"ticker={ticker}", "candles.parquet")


def write_pandascore_matches(
    matches: list[dict], data_root: str = DEFAULT_PANDASCORE_DATA_ROOT, overwrite: bool = False
) -> str:
    return _merge_and_write_parquet(matches, "id", overwrite, data_root, "matches.parquet")
