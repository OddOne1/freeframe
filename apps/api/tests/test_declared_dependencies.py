"""Every third-party package our code imports must be declared (§124).

Transcription had never once succeeded: faster-whisper 1.0.3 imports
`requests` at module scope but does not declare it, relying on
huggingface-hub -- which it pins as `>=0.13`, with no ceiling. huggingface-hub
1.0 replaced requests with httpx and dropped it, so a --no-cache rebuild
produced an image where `import requests` raised, on every attempt, forever.

That is a dependency nobody wrote down being provided by accident. This
checks our own half of that: a module we import directly has to appear in
requirements.txt, rather than arriving because some other package happens to
want it too. It found botocore and starlette when it was written.

Static and stdlib-only, so it runs in the container, in CI, and on a laptop
with none of these packages installed.
"""

import ast
import re
from pathlib import Path

API = Path(__file__).resolve().parents[1]
REPO = API.parents[1]
ROOTS = (API, REPO / "packages" / "transcoder")

# Top-level stdlib names this codebase actually imports. A allowlist rather
# than sys.stdlib_module_names, which does not exist before 3.10 and would
# make this check silently pass everything on an older interpreter.
STDLIB = {
    "abc", "argparse", "ast", "asyncio", "base64", "binascii", "calendar",
    "collections", "contextlib", "copy", "csv", "dataclasses", "datetime",
    "decimal", "email", "enum", "functools", "glob", "gzip", "hashlib",
    "hmac", "html", "inspect", "io", "itertools", "json", "logging", "math",
    "mimetypes", "operator", "os", "pathlib", "platform", "posixpath",
    "pprint", "random", "re", "secrets", "shlex", "shutil", "signal",
    "smtplib", "socket", "ssl", "statistics", "string", "struct",
    "subprocess", "sys", "tempfile", "textwrap", "threading", "time",
    "traceback", "types", "typing", "unittest", "urllib", "uuid", "warnings",
    "xml", "zipfile", "zlib",
}

# Local packages, reached without a relative import in scripts and tests.
LOCAL = {
    "apps", "packages", "alembic", "config", "conftest", "database", "main",
    "middleware", "models", "routers", "schemas", "services", "tasks", "utils",
}

# import name -> distribution name, where pip's name differs.
ALIAS = {
    "PIL": "pillow",
    "dotenv": "python-dotenv",
    "email_validator": "email-validator",
    "faster_whisper": "faster-whisper",
    "jose": "python-jose",
    "multipart": "python-multipart",
    "pillow_avif": "pillow-avif-plugin",
    "psycopg2": "psycopg2-binary",
    "pydantic_settings": "pydantic-settings",
    "yaml": "pyyaml",
}


def _declared() -> set:
    text = (API / "requirements.txt").read_text()
    out = set()
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.add(re.split(r"[<>=\[;]", line)[0].strip().lower().replace("_", "-"))
    return out


def _imported() -> dict:
    """{distribution name -> the files importing it}."""
    found = {}
    for root in ROOTS:
        for path in root.rglob("*.py"):
            if "__pycache__" in str(path):
                continue
            try:
                tree = ast.parse(path.read_text())
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name.split(".")[0] for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    # A relative import is always local.
                    if node.level or not node.module:
                        continue
                    names = [node.module.split(".")[0]]
                for name in names:
                    if name in STDLIB or name in LOCAL or name.startswith("_"):
                        continue
                    dist = ALIAS.get(name, name).lower().replace("_", "-")
                    found.setdefault(dist, set()).add(str(path.relative_to(REPO)))
    return found


def test_every_imported_package_is_declared():
    declared = _declared()
    missing = {d: sorted(f)[:3] for d, f in _imported().items() if d not in declared}
    assert not missing, (
        "imported but not in requirements.txt -- these work only for as long "
        f"as another package keeps pulling them in: {missing}"
    )


def test_requests_is_declared():
    """faster-whisper imports it and does not declare it."""
    assert "requests" in _declared()


def test_huggingface_hub_has_a_ceiling():
    """1.0 dropped requests; faster-whisper 1.0.3 still imports it."""
    text = (API / "requirements.txt").read_text()
    line = next(l for l in text.splitlines() if l.strip().startswith("huggingface-hub"))
    assert "<1.0" in line, f"needs an upper bound, got: {line.strip()}"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS  {name}")
            except AssertionError as exc:
                failures += 1
                print(f"  FAIL  {name}: {exc}")
    print("\nOK" if not failures else f"\n{failures} FAILED")
    raise SystemExit(1 if failures else 0)
