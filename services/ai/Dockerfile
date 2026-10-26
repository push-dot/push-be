# Base images are pinned by digest; Dependabot (.github/dependabot.yml) proposes bumps.
FROM python:3.15.0-slim-trixie@sha256:f5b92f2a669a4c347044f29367f31983280b648250ca94dea66f98c53bc87e58

COPY --from=ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff \
    /uv /usr/local/bin/uv

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    PATH=/opt/venv/bin:$PATH \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_NO_SANDBOX=1 \
    CHAT_EXECUTOR=local \
    DB_DRIVER=asyncpg \
    PG_TRANSPORT=tcp \
    PORT=8080

WORKDIR /app

# Dependencies before source, so a code-only change reuses this layer on the VPS.
# uv.lock pins every package with hashes; --locked fails if it is stale.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --extra local --no-install-project \
    && playwright install --with-deps chromium \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin app \
    && install -d -o app -g app /app/data /data/sources \
    && chown -R app:app /data /ms-playwright

# Source stays root-owned: the app user cannot rewrite its own code.
COPY src ./src
COPY scripts ./scripts
COPY eval ./eval

USER 10001
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz')"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
