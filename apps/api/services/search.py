"""One place that knows how to turn user text into a LIKE pattern (§233).

`routers/share.py` had `_escape_like` and used it; `routers/me.py`,
`routers/metadata.py` and `routers/users.py` built `f"%{text}%"` straight
from the request and did not. In those four places `%` was a wildcard, so
searching for it listed everything the caller could see, `_` matched any
single character, and a backslash could escape the next character of
somebody's search term. Not an injection — SQLAlchemy still parameterises
the string — but a filter that quietly does not filter, which for the
`/users/search` site means a one-character query enumerating every account
on the instance.

ONE mechanism, chosen deliberately: escape the three pattern characters
here and pass `escape="\\\\"` at the call site. The alternative,
`contains(..., autoescape=True)`, does the same job and SQLAlchemy writes
the ESCAPE clause itself — but it only exists on `contains`, and two of
these sites search `ilike` across several columns with one prepared
pattern. Mixing both would mean two answers to "is this string escaped
yet?" in one file, which is how the four unescaped sites happened in the
first place.

Usage, which is the whole API:

    from ..services.search import like_contains, LIKE_ESCAPE

    pattern = like_contains(q)
    query.filter(Asset.name.ilike(pattern, escape=LIKE_ESCAPE))

`escape=` is NOT optional. PostgreSQL happens to default to backslash, so
omitting it works there today and this module would still look correct —
and then silently stop being correct on any backend whose default differs,
or if a future SQLAlchemy stops relying on the server default. Stating it
costs one argument.
"""

#: The escape character handed to `ilike(..., escape=...)`. A single
#: backslash; it is doubled here only because this is a Python literal.
LIKE_ESCAPE = "\\"


def escape_like(text: str) -> str:
    """Make `text` match itself and nothing else inside a LIKE pattern.

    The backslash must be replaced FIRST. Escaping `%` and `_` introduces
    new backslashes, and doubling afterwards would escape those too —
    turning a search for `%` into a search for a literal backslash
    followed by anything.
    """
    return (
        text.replace(LIKE_ESCAPE, LIKE_ESCAPE * 2)
        .replace("%", LIKE_ESCAPE + "%")
        .replace("_", LIKE_ESCAPE + "_")
    )


def like_contains(text: str) -> str:
    """The `%…%` substring pattern for `text`, with `text` taken literally."""
    return f"%{escape_like(text)}%"
