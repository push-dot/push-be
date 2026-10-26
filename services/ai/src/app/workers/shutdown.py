import asyncio
import signal
from collections.abc import Callable


def stop_on_signals(stop: Callable[[], None]) -> None:
    """Route SIGTERM/SIGINT to a graceful stop instead of the default instant kill.

    Installed before uvicorn starts, so uvicorn's own handler restores it on exit
    and the re-raised signal still reaches ``stop``.
    """
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop)
