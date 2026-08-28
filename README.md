# hedge-trimmer

## Data

Ingested Kalshi data (markets + candlesticks) is stored in S3 at
[`s3://hedge-trimmer-juliangeorge/kalshi`](https://us-east-1.console.aws.amazon.com/s3/buckets/hedge-trimmer-juliangeorge?region=us-east-1&prefix=kalshi/&showversions=false).
This is the source of truth the UI reads from — not the local
`ingestion/data/raw/kalshi/` directory, which is a scratch/dev copy.

## Running the UI

```
source ingestion/.venv/bin/activate
python -m analysis.server
```

Then open http://127.0.0.1:8420 in your browser.
