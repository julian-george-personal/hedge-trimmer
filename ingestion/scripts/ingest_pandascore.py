import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from ingestion.clients.pandascore import PandaScoreClient
from ingestion.extract.pandascore_matches import fetch_cs2_matches
from ingestion.load.parquet_store import DEFAULT_PANDASCORE_DATA_ROOT, write_pandascore_matches


def parse_date_arg(date_str: str) -> datetime:
    return datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest CS2 matches from PandaScore, filtered by begin_at date")
    parser.add_argument("--start-date", required=True, help="YYYY-MM-DD, inclusive, filters by match begin_at")
    parser.add_argument("--end-date", required=True, help="YYYY-MM-DD, inclusive, filters by match begin_at")
    parser.add_argument(
        "--data-root", default=DEFAULT_PANDASCORE_DATA_ROOT, help="Local path or s3:// URI for Parquet output"
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    client = PandaScoreClient.from_credentials_dir()

    from_time = parse_date_arg(args.start_date)
    to_time = parse_date_arg(args.end_date) + timedelta(days=1)

    matches = fetch_cs2_matches(client, from_time, to_time)
    print(f"found {len(matches)} CS2 matches beginning between {args.start_date} and {args.end_date}")
    write_pandascore_matches(matches, args.data_root)


if __name__ == "__main__":
    main()
