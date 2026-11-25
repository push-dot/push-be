"""Moved to `app.harness.kstyle.subagent`; this shim keeps resume's imports working. Patch
`app.harness.kstyle.subagent.SUB_SECONDS`, not this module: `timed` reads the global there."""
from app.harness.kstyle.subagent import *  # noqa: F403
from app.harness.kstyle.subagent import (  # noqa: F401
    LIGHT_MODEL,
    SUB_SECONDS,
    Corpus,
    Emit,
    FindingArgs,
    SubBudget,
    Tool,
    light_model,
    line,
    mid_model,
    parse,
    run_subagent,
    single_call,
    squash,
    timed,
)
