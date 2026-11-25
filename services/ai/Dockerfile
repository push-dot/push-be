# One file, two services: `--target push-bot` (the consumer Bot, with Chromium) and
# `--target push-agent` (the enterprise agent, no browser). Both sit on the shared package src/app.
# A build with no target makes push-bot, which also runs the dispatcher and the ingest and notify workers.
# Each image starts its API by default; the VPS compose files start the queue worker instead (SERVE_API=1
# keeps the API in that process).
# Base images are pinned by digest; Dependabot (.github/dependabot.yml) proposes bumps.
FROM python:3.15.2-slim-trixie@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928 AS deps

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
# shortcut: zstandard 0.25.0 ships no cp315 wheels, so it compiles here and the compiler is
# purged in the same layer; drop gcc once it publishes cp315 wheels.
# libatomic1 is installed explicitly so the purge keeps it: playwright's bundled node links it.
COPY pyproject.toml uv.lock ./
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libatomic1 \
    && uv sync --locked --no-dev --extra local --no-install-project \
    && apt-get purge -y --auto-remove gcc libc6-dev && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin app \
    && install -d -o app -g app /app/data /data/sources \
    && chown -R app:app /data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz')"


# push-agent never opens a page (company research is the model's own search), so it ships no browser.
FROM deps AS push-agent

# Source stays root-owned: the app user cannot rewrite its own code.
COPY src/app ./src/app
COPY src/push_agent ./src/push_agent
COPY scripts ./scripts
COPY eval/employer ./eval/employer

USER 10001

CMD ["python", "-m", "uvicorn", "push_agent.main:app", "--host", "0.0.0.0", "--port", "8080"]


FROM deps AS push-bot

# Chromium for read_page and the PDF export, in its own layer under the source so a code change reuses it.
RUN playwright install --with-deps chromium \
    && chown -R app:app /ms-playwright

COPY src/app ./src/app
COPY src/push_bot ./src/push_bot
COPY scripts ./scripts
COPY eval/rag ./eval/rag

USER 10001

CMD ["python", "-m", "uvicorn", "push_bot.main:app", "--host", "0.0.0.0", "--port", "8080"]
