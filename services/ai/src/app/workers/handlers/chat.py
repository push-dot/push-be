_harness = None


def configure_harness(run) -> None:
    global _harness
    _harness = run


async def chat(ctx) -> dict:
    if _harness is None:
        raise RuntimeError("chat handler is not configured")
    handled = await _harness(ctx)
    if handled is None:
        raise RuntimeError("chat harness did not handle the job")
    return handled
