import re
from datetime import datetime

from analysis.data import list_pandascore_matches

_NORMALIZE_RE = re.compile(r"[^a-z0-9]+")


def _normalize_team_name(name: str) -> str:
    return _NORMALIZE_RE.sub("", name.lower())


def _parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _team_name_pair(match: dict) -> frozenset[str] | None:
    names = [_normalize_team_name(o["opponent"]["name"]) for o in match.get("opponents", []) if o.get("opponent")]
    return frozenset(names) if len(names) == 2 else None


def _closest_to(matches: list[dict], target_time: datetime) -> dict:
    return min(matches, key=lambda m: abs(_parse_iso(m["begin_at"]) - target_time))


# Built once per process from the bulk-ingested S3 dataset and reused across
# lookups — re-reading and re-scanning ~2000 rows from S3 on every request
# was the dominant cost of /api/match-start. The dataset only changes via a
# manual re-ingestion run, so a server restart is what picks up fresh data,
# same operational model as the rest of the app.
_team_pair_index_cache: dict[frozenset, list[dict]] | None = None


def _team_pair_index() -> dict[frozenset, list[dict]]:
    global _team_pair_index_cache
    if _team_pair_index_cache is None:
        index: dict[frozenset, list[dict]] = {}
        for match in list_pandascore_matches():
            pair = _team_name_pair(match)
            if pair is not None:
                index.setdefault(pair, []).append(match)
        _team_pair_index_cache = index
    return _team_pair_index_cache


def find_match_start(event: dict) -> str | None:
    """Look up the PandaScore begin_at for the CS2 match backing this Kalshi
    event, matched by team-name pair against the bulk-ingested S3 dataset.
    Returns an ISO 8601 timestamp, or None if no match is found."""
    team_names = [_normalize_team_name(m["team_name"]) for m in event["markets"]]
    if len(team_names) != 2:
        return None
    target_pair = frozenset(team_names)

    candidates = _team_pair_index().get(target_pair)
    if not candidates:
        return None

    close_time = _parse_iso(event["close_time"])
    return _closest_to(candidates, close_time)["begin_at"]
