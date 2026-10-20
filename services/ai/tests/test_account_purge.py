import os

from app.account_purge import remove_images
from app.infrastructure.images import image_dir


def test_remove_images_deletes_only_listed_keys(tmp_path):
    directory = image_dir(str(tmp_path))
    os.makedirs(directory)
    for name in ("a.png", "b.png"):
        open(os.path.join(directory, name), "wb").close()
    outside = tmp_path / "secret.txt"
    outside.write_text("x")

    remove_images(str(tmp_path), ["a.png", "missing.png", "../secret.txt"])

    assert sorted(os.listdir(directory)) == ["b.png"]
    assert outside.exists()
