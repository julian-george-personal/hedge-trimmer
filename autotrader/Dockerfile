# Build from the repo root so this can COPY the autotrader/ package as a
# whole: `docker build -f autotrader/Dockerfile .`
FROM python:3.12-slim

WORKDIR /app

COPY autotrader/requirements.txt autotrader/requirements.txt
RUN pip install --no-cache-dir -r autotrader/requirements.txt

COPY autotrader autotrader

# The aws-apprunner-application Terraform module hardcodes port 80 for every
# app it fronts (not configurable per-app) — match that rather than adding a
# port variable to a module several other apps already depend on.
ENV PORT=80
EXPOSE 80

CMD ["python", "-m", "autotrader"]
