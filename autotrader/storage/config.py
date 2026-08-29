from dataclasses import asdict, dataclass, replace
from decimal import Decimal

from autotrader.storage.state import Store

DEFAULTS = {
    "side": "underdog",
    "bet_per_match_dollars": 5.0,
    "pre_match_volume_min": 0.0,
    "pre_match_volume_max": 1_000_000.0,
    "win_prob_min": 0.0,
    "win_prob_max": 100.0,
    "stop_loss_percent": 0.0,
    "take_profit_percent": 100.0,
    "lead_time_minutes": 5.0,
    "order_style": "limit",
    "enabled": False,
    "armed": False,
    "filters_updated_at": None,
}


@dataclass
class TradingConfig:
    side: str
    bet_per_match_dollars: float
    pre_match_volume_min: float
    pre_match_volume_max: float
    win_prob_min: float
    win_prob_max: float
    stop_loss_percent: float
    take_profit_percent: float
    lead_time_minutes: float
    order_style: str
    enabled: bool
    armed: bool
    filters_updated_at: str | None

    @classmethod
    def defaults(cls) -> "TradingConfig":
        return cls(**DEFAULTS)

    @classmethod
    def from_item(cls, item: dict) -> "TradingConfig":
        merged = {**DEFAULTS, **item}
        return cls(
            side=merged["side"],
            bet_per_match_dollars=float(merged["bet_per_match_dollars"]),
            pre_match_volume_min=float(merged["pre_match_volume_min"]),
            pre_match_volume_max=float(merged["pre_match_volume_max"]),
            win_prob_min=float(merged["win_prob_min"]),
            win_prob_max=float(merged["win_prob_max"]),
            stop_loss_percent=float(merged["stop_loss_percent"]),
            take_profit_percent=float(merged["take_profit_percent"]),
            lead_time_minutes=float(merged["lead_time_minutes"]),
            order_style=merged["order_style"],
            enabled=bool(merged["enabled"]),
            armed=bool(merged["armed"]),
            filters_updated_at=merged["filters_updated_at"],
        )

    def to_item(self) -> dict:
        item = asdict(self)
        for key, value in item.items():
            if isinstance(value, float):
                item[key] = Decimal(str(value))
        return item

    def with_updates(self, **updates) -> "TradingConfig":
        return replace(self, **updates)


def load_config(store: Store) -> TradingConfig:
    item = store.get_config()
    return TradingConfig.from_item(item) if item else TradingConfig.defaults()


def save_config(store: Store, config: TradingConfig) -> None:
    store.put_config(config.to_item())
