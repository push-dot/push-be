"""push-bot's queue worker: personal chat turns, document jobs and fit scores."""

import asyncio

QUEUES = ["q:chat:priority", "q:chat", "q:document"]


def handlers(deps, query) -> dict:
    from app.workers.handlers.chat import chat
    from app.workers.handlers.document import make_document
    from app.workers.handlers.fit import make_fit

    gate = getattr(getattr(deps, "ai", None), "gate", None)
    return {
        "chat": chat,
        "document": make_document(deps.documents),
        "fit": make_fit(query, gate),
    }


async def main() -> None:
    from app.workers.ai_worker_main import run
    from push_bot.main import app

    await run(app, queues=QUEUES, handlers=handlers, group="ai", consumer="ai-worker",
              fair_queue="q:document")


if __name__ == "__main__":
    asyncio.run(main())
