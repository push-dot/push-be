"""push-agent's queue worker: employer turns."""

import asyncio

QUEUES = ["q:agent:priority", "q:agent"]


def handlers(_deps, _query) -> dict:
    from app.workers.handlers.chat import chat

    return {"employer_ai": chat}


async def main() -> None:
    from app.workers.ai_worker_main import run
    from push_agent.main import app

    await run(app, queues=QUEUES, handlers=handlers, group="agent", consumer="agent-worker")


if __name__ == "__main__":
    asyncio.run(main())
