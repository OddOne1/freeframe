"""The Whisper model cache must be writable by the user that runs (§125).

Transcription failed with

    PermissionError: [Errno 13] Permission denied: '/home/appuser'

from huggingface_hub's downloader, and two independent mistakes produced it:

  * the image created appuser with `--no-create-home`, so /home/appuser did
    not exist. HOME is still /home/appuser for that user, so anything
    defaulting to ~/.cache tried to create a directory under /home, which is
    root-owned and 755. Whisper's model download was the first thing in this
    image that ever wanted a home.

  * the volume that exists to persist the model -- so a mandatory --no-cache
    rebuild does not re-download hundreds of MB -- was mounted at
    /root/.cache/huggingface. The container runs as appuser, not root, so
    the process never looked there and could not have written there.

Static, stdlib-only: there is no Docker daemon on the machine this was
written on, so what can be checked here is the configuration, not a running
container. Whether the model actually downloads has to be confirmed on the
server.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DOCKERFILE = REPO / "apps" / "api" / "Dockerfile.prod"
COMPOSE = REPO / "docker-compose.prod.yml"


def _dockerfile() -> str:
    return DOCKERFILE.read_text()


def _hf_home() -> str:
    m = re.search(r"^ENV HF_HOME=(\S+)", _dockerfile(), re.M)
    assert m, "HF_HOME is not set in the image"
    return m.group(1)


def _service_block(name: str) -> str:
    text = COMPOSE.read_text()
    start = text.index(f"\n  {name}:")
    nxt = re.search(r"\n  [A-Za-z_][\w-]*:", text[start + 3:])
    return text[start:start + 3 + nxt.start()] if nxt else text[start:]


def test_appuser_has_a_home():
    """--no-create-home is what the PermissionError was actually about."""
    line = next(l for l in _dockerfile().splitlines() if "adduser" in l)
    assert "--no-create-home" not in line, line.strip()


def test_cache_dir_is_created_and_owned_by_appuser():
    df = _dockerfile()
    hf = _hf_home()
    assert f"mkdir -p {hf}" in df, f"{hf} is never created"
    assert re.search(r"chown -R appuser:appuser", df), "the cache is never chowned"


def test_cache_is_prepared_before_the_image_drops_privileges():
    """chown needs root; after USER appuser it would fail the build."""
    df = _dockerfile()
    assert df.index("chown -R appuser:appuser") < df.index("\nUSER appuser")


def test_the_model_volume_mounts_exactly_where_the_cache_lives():
    """A volume at a path the process never reads is not a cache."""
    block = _service_block("transcribe_worker")
    hf = _hf_home()
    assert re.search(rf"-\s+\S+:{re.escape(hf)}\b", block), (
        f"transcribe_worker mounts nothing at {hf}:\n{block}"
    )


def test_nothing_is_mounted_under_root_home():
    """The original bug, generalised: these containers do not run as root."""
    text = COMPOSE.read_text()
    offenders = [l.strip() for l in text.splitlines()
                 if re.search(r"-\s+\S+:/root/", l) and not l.strip().startswith("#")]
    assert not offenders, offenders


def test_declared_volume_exists():
    block = _service_block("transcribe_worker")
    m = re.search(r"-\s+(\w+):/", block)
    assert m, "no named volume on transcribe_worker"
    name = m.group(1)
    volumes = COMPOSE.read_text().split("\nvolumes:")[-1]
    assert re.search(rf"^\s+{name}:", volumes, re.M), f"{name} is not declared"


if __name__ == "__main__":
    failures = 0
    for fname, fn in sorted(globals().items()):
        if fname.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS  {fname}")
            except AssertionError as exc:
                failures += 1
                print(f"  FAIL  {fname}: {exc}")
    print("\nOK" if not failures else f"\n{failures} FAILED")
    raise SystemExit(1 if failures else 0)
