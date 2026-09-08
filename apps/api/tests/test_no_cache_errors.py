"""Error responses are never cacheable (§128).

A `/api/api/...` typo produced a 404 the browser then replayed from DISK
CACHE for four hours:

    404, Cache-Control: max-age=14400, Content-Length: 22

22 bytes is exactly `{"detail":"Not Found"}` — FastAPI's unmatched-route
404, which sets no Cache-Control at all. 14400 seconds is four hours, which
is Cloudflare's default Browser Cache TTL, applied to responses that reach
the edge without a caching policy of their own. This deployment is behind a
Cloudflare Tunnel. An origin policy overrides that default, so setting one
settles it for the edge and the browser together.

Why it matters beyond tidiness: once a client has hit a broken URL, fixing
the bug server-side changes nothing for that client until the cache expires,
because the browser stops asking.

Behaviour verified for real against starlette 0.38.6 while this was written
— 200 with `max-age=31536000` untouched; explicit 404, 500, 429 and the
unmatched-route 404 all `no-store`. These checks pin that shape statically,
since the API's own suite needs a container this machine does not have.
"""

import re
from pathlib import Path

API = Path(__file__).resolve().parents[1]
MW = API / "middleware" / "no_cache_errors.py"


def _code(path: Path) -> str:
    """Source without comments or docstrings — this file's prose names the
    very headers being asserted on."""
    out, in_doc = [], False
    for line in path.read_text().splitlines():
        st = line.strip()
        if in_doc:
            if st.endswith('"""'):
                in_doc = False
            continue
        if st.startswith('"""'):
            if not (len(st) > 3 and st.endswith('"""')):
                in_doc = True
            continue
        if st.startswith("#"):
            continue
        out.append(line)
    return "\n".join(out)


def test_the_middleware_exists():
    assert MW.exists()


def test_it_only_touches_error_responses():
    """A .ts segment is deliberately cached for a year; that must survive."""
    code = _code(MW)
    assert "status_code >= 400" in code


def test_it_sets_no_store():
    """no-store, not no-cache: no-cache still permits a stored copy that is
    revalidated, and there is nothing worth storing about an error."""
    code = _code(MW)
    assert '"Cache-Control"] = "no-store"' in code


def test_it_is_registered_outermost():
    """Starlette's add_middleware inserts at the FRONT of the stack, so the
    last one added runs outermost. Registered any earlier, it would miss the
    rate limiter's 429s and anything the setup guard short-circuits.
    """
    code = _code(API / "main.py")
    adds = [l.strip() for l in code.splitlines() if l.strip().startswith("app.add_middleware(")]
    assert adds, "no middleware registered"
    assert "NoCacheErrorsMiddleware" in adds[-1], (
        f"must be the last add_middleware call to run outermost; got {adds[-1]}"
    )


def test_success_caching_policy_is_left_alone():
    """The proxy's own success-path headers are not rewritten here."""
    code = _code(MW)
    assert "status_code < 400" not in code
    assert "max-age" not in code


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
