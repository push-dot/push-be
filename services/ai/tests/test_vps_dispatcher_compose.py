from pathlib import Path


def test_dispatcher_reads_the_data_volume_and_blobs_stay_in_db():
    text = Path(__file__).resolve().parents[3].joinpath("infra/vps/compose.yaml").read_text()
    assert "BLOB_STORE: db" in text
    start = text.index("\n  dispatcher:\n")
    end = text.index("\n  ai-worker:\n")
    block = text[start:end]
    assert "ai-data:/data:ro" in block
    assert "STORAGE_DIR: /data/sources" in block
