FROM python:3.12.7-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_NO_SANDBOX=1 \
    CHAT_EXECUTOR=local \
    AI_FRAMEWORK=legacy \
    DB_DRIVER=asyncpg \
    PG_TRANSPORT=tcp \
    PORT=8080

WORKDIR /app

COPY pyproject.toml ./
COPY src ./src

RUN pip install --no-cache-dir ".[local]" \
    && playwright install --with-deps chromium \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin app \
    && mkdir -p /data/sources /ms-playwright \
    && chown -R app:app /app /data /ms-playwright

USER 10001
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz')"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
