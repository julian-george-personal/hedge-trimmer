import boto3

CONFIG_KEY = {"PK": "CONFIG", "SK": "CONFIG"}


def _position_key(event_ticker: str) -> dict:
    return {"PK": f"POSITION#{event_ticker}", "SK": "POSITION"}


def _scan_key(event_ticker: str, scanned_at: str) -> dict:
    return {"PK": f"SCAN#{event_ticker}", "SK": scanned_at}


class Store:
    def __init__(self, table_name: str, region_name: str = "us-east-1"):
        # Unlike Lambda, App Runner containers don't get AWS_REGION injected
        # automatically — boto3 raises NoRegionError without an explicit
        # region_name (confirmed by running the built image locally with no
        # region configured).
        self.table = boto3.resource("dynamodb", region_name=region_name).Table(table_name)

    def get_config(self) -> dict | None:
        item = self.table.get_item(Key=CONFIG_KEY).get("Item")
        return item

    def put_config(self, config: dict) -> None:
        self.table.put_item(Item={**CONFIG_KEY, **config})

    def get_position(self, event_ticker: str) -> dict | None:
        return self.table.get_item(Key=_position_key(event_ticker)).get("Item")

    def put_position(self, event_ticker: str, position: dict) -> None:
        self.table.put_item(Item={**_position_key(event_ticker), **position})

    def list_positions(self) -> list[dict]:
        return [item for item in self._scan_table() if item["PK"].startswith("POSITION#")]

    def list_open_positions(self) -> list[dict]:
        return [position for position in self.list_positions() if position.get("status") == "open"]

    def put_market_scan(self, event_ticker: str, scanned_at: str, item: dict) -> None:
        self.table.put_item(Item={**_scan_key(event_ticker, scanned_at), **item})

    def list_market_scans(self) -> list[dict]:
        return [item for item in self._scan_table() if item["PK"].startswith("SCAN#")]

    def _scan_table(self) -> list[dict]:
        items = []
        response = self.table.scan()
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = self.table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
            items.extend(response.get("Items", []))
        return items
