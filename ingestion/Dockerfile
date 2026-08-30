# Build from the repo root so this can COPY the ingestion/ package as a
# whole: `docker build -f ingestion/Dockerfile .`
FROM python:3.13-slim

WORKDIR /app

COPY ingestion/requirements.txt ingestion/requirements.txt
RUN pip install --no-cache-dir -r ingestion/requirements.txt

COPY ingestion ingestion

# One-shot batch job, not a server: ECS runs this to completion on each
# scheduled invocation rather than keeping a process alive.
CMD ["python", "-m", "ingestion"]
