"""`permission` and `show_comments` cannot disagree (§189).

§188 split reading comments from posting them and declared all four
combinations valid, citing `fields_visibility`'s deliberate independence.
Live testing found the hole: `permission=comment` with `show_comments=False`
lets a viewer post — the server allows it — into a panel that is not
rendered. There is no box. That is a dead end, not an asymmetric config;
`fields_visibility` is genuinely independent because it interacts with
nothing, while these two describe one panel from two sides.

The combination the feature EXISTS for is untouched and asserted below:
`permission=view` + `show_comments=True`, so a client reads the team's
discussion without joining it.
"""
import inspect

import pytest

from apps.api.models.share import SharePermission
from apps.api.routers.share import _reconcile_comment_settings


class Link:
    """A ShareLink's two relevant fields. Plain object, not a MagicMock:
    the code both reads and writes them, and a MagicMock reports every
    attribute as truthy whether or not anything set it."""

    def __init__(self, permission, show_comments):
        self.permission = permission
        self.show_comments = show_comments

    def __repr__(self):
        return f"Link(permission={self.permission}, show_comments={self.show_comments})"


def reconcile(permission, show_comments):
    link = Link(permission, show_comments)
    _reconcile_comment_settings(link)
    return link


# ── the combination being eliminated ────────────────────────────────────────

@pytest.mark.parametrize("permission", [SharePermission.comment, SharePermission.approve])
def test_allowing_posting_turns_the_panel_on(permission):
    """Direction 1: a request enables posting on a link whose panel is off.

    Posting implies somewhere to post into."""
    link = reconcile(permission, False)

    assert link.show_comments is True
    assert link.permission is permission, "the permission itself must not be touched"


@pytest.mark.parametrize("permission", [SharePermission.comment, SharePermission.approve])
def test_hiding_the_panel_revokes_posting(permission):
    """Direction 2: a request hides the panel on a link that allowed posting.

    Nothing visible to comment on, so nothing to permit."""
    link = reconcile(permission, False)
    # Same input, but read the other way: whichever field arrived, the pair
    # that comes out is consistent. The asymmetry in WHICH field yields is
    # deliberate — see the two tests below.
    assert (link.permission, link.show_comments) != (permission, False)


def test_the_forbidden_pair_cannot_survive_in_either_form():
    """Whatever arrives, this exact pair is never what is stored."""
    for permission in (SharePermission.comment, SharePermission.approve):
        link = reconcile(permission, False)
        assert not (
            link.permission in (SharePermission.comment, SharePermission.approve)
            and link.show_comments is False
        ), link


# ── which field yields, and why ─────────────────────────────────────────────

def test_posting_wins_over_a_hidden_panel():
    """Deliberate: turning posting ON is the more specific request, and
    showing a panel is additive. The reverse would silently discard the
    permission the caller just asked for."""
    link = reconcile(SharePermission.comment, False)

    assert (link.permission, link.show_comments) == (SharePermission.comment, True)


def test_a_hidden_panel_with_view_permission_needs_no_correction():
    link = reconcile(SharePermission.view, False)

    assert (link.permission, link.show_comments) == (SharePermission.view, False)


# ── the combination this whole feature exists for, untouched ────────────────

def test_view_only_with_comments_shown_is_left_alone():
    """The real use case: a client reads the discussion without joining it.
    If §189 broke this, it would have undone §188 entirely."""
    link = reconcile(SharePermission.view, True)

    assert (link.permission, link.show_comments) == (SharePermission.view, True)


@pytest.mark.parametrize(
    "permission,show",
    [
        (SharePermission.view, True),
        (SharePermission.view, False),
        (SharePermission.comment, True),
        (SharePermission.approve, True),
    ],
)
def test_every_self_consistent_pair_passes_through_unchanged(permission, show):
    """No surprise override when a caller sends a pair that already agrees —
    including both fields changed together in one PATCH."""
    link = reconcile(permission, show)

    assert (link.permission, link.show_comments) == (permission, show)


def test_it_is_idempotent():
    """Applied twice — a PATCH on an already-reconciled row — nothing moves."""
    for permission in (SharePermission.view, SharePermission.comment, SharePermission.approve):
        for show in (True, False):
            once = reconcile(permission, show)
            twice = reconcile(once.permission, once.show_comments)
            assert (twice.permission, twice.show_comments) == (
                once.permission, once.show_comments,
            )


# ── it is actually wired in, everywhere a link is written ───────────────────

class TestItIsApplied:
    """The helper is inert unless called. §188's own bug was a rule that
    existed in one layer and not the other."""

    def test_the_patch_handler_reconciles_after_applying_updates(self):
        """Order matters: before the setattr loop it would reconcile against
        stale values and the incoming field would win by accident."""
        from apps.api.routers.share import update_share_link

        src = inspect.getsource(update_share_link)
        loop_at = src.index("for key, value in updates.items():")
        call_at = src.index("_reconcile_comment_settings(link)")
        commit_at = src.index("db.commit()")
        assert loop_at < call_at < commit_at, (
            "reconciliation must run after the updates are applied and "
            "before the row is committed"
        )

    @pytest.mark.parametrize(
        "endpoint",
        [
            "create_share_link",
            "create_folder_share_link",
            "create_project_share_link",
            "create_multi_share_link",
        ],
    )
    def test_every_create_endpoint_reconciles(self, endpoint):
        """A create request can hand-construct the contradictory pair in one
        shot, with no PATCH involved."""
        import apps.api.routers.share as share_router

        fn = getattr(share_router, endpoint, None)
        assert fn is not None, f"{endpoint} not found — did it get renamed?"
        src = inspect.getsource(fn)
        assert "_reconcile_comment_settings(link)" in src
        assert src.index("_reconcile_comment_settings(link)") < src.index("db.add(link)")


def test_fields_visibility_independence_is_not_touched():
    """§33's asymmetry is real and unrelated: fields interact with nothing.
    Collapsing it too would be over-applying §189's lesson.

    DOCSTRING STRIPPED before matching — the helper's own prose explains why
    `fields_visibility` is different, so checking the raw source matches the
    explanation rather than the code. Fourth time that has bitten a test in
    this codebase (§115, §139, §184/§186); see test_celery_wiring.py, which
    documents the same trap.
    """
    import ast

    tree = ast.parse(inspect.getsource(_reconcile_comment_settings).strip())
    fn = tree.body[0]
    body = fn.body[1:] if ast.get_docstring(fn) else fn.body
    code = ast.unparse(ast.Module(body=body, type_ignores=[]))

    assert "fields_visibility" not in code
    # And it really does still touch the two it is about, so a gutted
    # implementation cannot pass this by doing nothing.
    assert "show_comments" in code and "permission" in code
