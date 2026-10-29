from langgraph.types import interrupt

_MAX_CYCLES = 5


def boost_cycle(state: dict) -> dict:
    scores = [float(score) for score in state.get("scores") or []]
    previous = scores[0] if scores else 0.0
    history = []
    stall = 0
    stopped = "max"
    for after in scores[1:]:
        if len(history) == _MAX_CYCLES:
            break
        gain = round(after - previous, 1)
        step = {"cycle": len(history) + 1, "before": previous, "after": after, "gain": gain}
        history.append(step)
        interrupt(step)
        previous = after
        if gain < 0.1:
            stall += 1
            if stall == 2:
                stopped = "stall"
                break
        else:
            stall = 0
    if stopped == "max" and len(history) < _MAX_CYCLES:
        stopped = "continue"
    return {
        "cycles": len(history),
        "score": history[-1]["after"] if history else None,
        "stopped": stopped,
        "history": history,
    }
