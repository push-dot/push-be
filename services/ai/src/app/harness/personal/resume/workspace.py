"""00_notes.json: the explore loop's scratchpad and evidence ledger. Moved to `app.harness.kstyle.ledger`
and `app.harness.kstyle.workspace`; this shim keeps resume's imports working."""
from app.harness.kstyle.ledger import Evidence, Notes, add_evidence, empty_notes, ledger_text  # noqa: F401
from app.harness.kstyle.workspace import NOTES_FILE, load_notes, save_notes  # noqa: F401
