"""What a NEW file's transcription toggle starts as (§127).

The rule this implements, which is fixed rather than a preference: a
project's default decides only the STARTING state of a file's own toggle at
the moment that file is created. It never touches a file that already
exists, and it is not an ongoing link -- a file's toggle can be flipped
against its project's default in either direction afterwards, and nothing
reconciles them later.

Written as one resolver with an explicit chain rather than inline at the
call site, because that is what makes a folder-level override a one-column
change later: insert it ahead of the project in `_first_set` and nothing
else moves.
"""

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # pragma: no cover
    # Type-only: this module reads one attribute and needs no ORM at runtime,
    # which also lets the rule be tested without a database or the package.
    from ..models.project import Project

# What the app did before any of this existed: every video and audio upload
# was transcribed unconditionally. A project that has never expressed a
# preference keeps that behaviour.
APP_DEFAULT = True


def _first_set(*values: Optional[bool]) -> bool:
    """The first value that is not None, else the app-wide default.

    None means "nobody chose", which is deliberately distinct from an
    explicit False -- only the former falls through to the next level.
    """
    for value in values:
        if value is not None:
            return value
    return APP_DEFAULT


def default_transcription_enabled(project: "Optional[Project]") -> bool:
    """Resolve the starting toggle for a file about to be created."""
    return _first_set(getattr(project, "transcription_default", None) if project else None)
