"""Reading comments is a separate setting from posting them (§188).

`permission` (view/comment/approve) decided both whether a viewer may POST
a comment and — via the frontend's use-share-sidebar — whether the panel
existed at all. So a view-only link hid the team's existing discussion
outright.

The server never conflated the two: GET /share/{token}/comments has no
permission gate and never had one, only POST does. `show_comments` adds the
missing persisted flag; no authorization changes.
"""
import inspect

from apps.api.models.share import ShareLink
from apps.api.schemas.share import (
    MultiShareCreate,
    ShareLinkCreate,
    ShareLinkResponse,
    ShareLinkUpdate,
    ShareLinkValidateResponse,
)


class TestTheColumn:
    def test_it_exists_and_is_not_nullable(self):
        col = ShareLink.__table__.c.show_comments
        assert col.nullable is False

    def test_it_defaults_to_showing(self):
        """A NEW link shows comments. Existing rows are a different question,
        answered by the migration's backfill rather than by this default —
        see test_the_backfill_preserves_current_behaviour."""
        assert str(ShareLink.__table__.c.show_comments.server_default.arg) == "true"

    def test_it_is_independent_of_permission(self):
        """Not derived, not a computed property — a column of its own, the
        way fields_visibility already is."""
        assert "show_comments" in ShareLink.__table__.c
        assert ShareLink.__table__.c.show_comments.type.python_type is bool


class TestTheSchemas:
    """Every place `show_versions` travels, its new sibling travels too —
    that field is the closest analog and the checklist for this one."""

    def test_create_schemas_carry_it(self):
        assert ShareLinkCreate().show_comments is True
        assert MultiShareCreate().show_comments is True

    def test_the_validate_response_carries_it(self):
        """The guest page reads this to decide whether to render the panel;
        without it here the flag never reaches a viewer."""
        assert "show_comments" in ShareLinkValidateResponse.model_fields
        assert ShareLinkValidateResponse.model_fields["show_comments"].default is True

    def test_the_detail_response_carries_it(self):
        """The owner's settings panel reads this to render the toggle."""
        assert "show_comments" in ShareLinkResponse.model_fields

    def test_update_treats_it_as_optional(self):
        """PATCH uses model_dump(exclude_unset=True), so an omitted field
        must stay omitted rather than defaulting to True and silently
        switching comments on for a link nobody touched."""
        assert ShareLinkUpdate().show_comments is None
        assert "show_comments" not in ShareLinkUpdate().model_dump(exclude_unset=True)

    def test_an_explicit_false_survives_exclude_unset(self):
        """The failure mode of the above done wrong: False is falsy, and a
        dump that dropped it would make the toggle impossible to turn off."""
        dumped = ShareLinkUpdate(show_comments=False).model_dump(exclude_unset=True)
        assert dumped == {"show_comments": False}

    def test_it_sits_beside_show_versions_everywhere_that_one_does(self):
        for schema in (ShareLinkCreate, MultiShareCreate, ShareLinkValidateResponse,
                       ShareLinkResponse, ShareLinkUpdate):
            assert ("show_versions" in schema.model_fields) == (
                "show_comments" in schema.model_fields
            ), schema.__name__


class TestTheMigration:
    from apps.api.alembic.versions import add_share_show_comments as mig

    def test_the_backfill_preserves_current_behaviour(self):
        """server_default alone is NOT enough, and that is the whole point.

        "true" would switch comments ON for every existing view-only link
        the moment this deploys — exposing internal discussion on links
        already in clients' hands. The backfill sets existing rows from what
        the frontend derives today, so nothing visibly changes until an
        owner flips the new toggle.
        """
        src = inspect.getsource(self.mig.upgrade)
        assert "UPDATE share_links SET show_comments" in src
        assert "permission != 'view'" in src

    def test_the_enum_literal_is_cast(self):
        """Belt and braces, and stated as such rather than overclaimed.

        Verified against real Postgres 15: the same UPDATE WITHOUT the cast
        also succeeds, because Postgres infers an unknown literal's type
        from the comparison. CLAUDE.md's hard rule is about ASSIGNING a
        literal to an enum column, which is a genuine DatatypeMismatch and
        did crash-loop a deploy (add_user_global_role, 2026-07-20). This is
        the adjacent case, so the cast is kept for explicitness — but it is
        not what makes the migration work, and pretending otherwise would
        misdescribe the rule for whoever reads it next.
        """
        assert "::sharepermission" in inspect.getsource(self.mig.upgrade)

    def test_it_can_be_undone(self):
        assert "drop_column" in inspect.getsource(self.mig.downgrade)


def test_reading_comments_still_has_no_permission_gate():
    """The premise this feature rests on, asserted rather than assumed.

    If GET ever grew a `permission` check, `show_comments: true` on a
    view-only link would render an empty panel instead of the discussion —
    the feature would silently do nothing.
    """
    from apps.api.routers.comments import list_share_comments

    src = inspect.getsource(list_share_comments)
    assert "SharePermission" not in src
    assert "permission" not in src


def test_posting_comments_still_checks_permission():
    """The other half: this task must not change who may post."""
    from apps.api.routers.comments import guest_comment

    src = inspect.getsource(guest_comment)
    assert "link.permission == SharePermission.view" in src
    assert "403" in src or "status_code=403" in src
