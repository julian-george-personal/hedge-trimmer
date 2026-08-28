import tomllib
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent / "config.toml"


def load_config() -> dict:
    with open(CONFIG_PATH, "rb") as f:
        return tomllib.load(f)
