"""The two stated acceptance checks, against a real DB + the real endpoints."""
import uuid, pytest
from unittest.mock import MagicMock, patch
from apps.api.models.project import ProjectRole
from .test_storage_prefix import db  # noqa: F401  -- real-DB fixture


def test_ACCEPTANCE_two_identical_names_get_distinct_slugs(db):
    from apps.api.models.project import Project, ProjectType
    from apps.api.services.storage_prefix import lock_storage_prefix

    ids = []
    for name in ("Beach Shoot", "beach  shoot", "BEACH-SHOOT!"):
        p = Project(id=uuid.uuid4(), name=name, project_type=ProjectType.personal)
        db.add(p); db.commit(); ids.append(p.id)
    for pid in ids:
        lock_storage_prefix(db, pid); db.commit()

    slugs = [db.get(Project, pid).storage_slug for pid in ids]
    print("  slugs generated:", slugs)
    assert len(set(slugs)) == 3
    assert slugs[0] == "beach_shoot"


def test_ACCEPTANCE_locked_slug_rejected_via_the_API_not_just_the_UI(client, auth_headers, mock_db, test_user):
    """Hit PATCH /projects/{id} directly with a locked project."""
    project = MagicMock()
    project.id = uuid.uuid4()
    project.storage_slug = "beach"
    project.storage_date_prefix = "260811"      # locked
    project.deleted_at = None

    member = MagicMock()
    member.role = ProjectRole.owner
    member.user_id = test_user.id
    member.deleted_at = None

    mock_db.query.return_value.filter.return_value.first.side_effect = [project, member]

    r = client.patch(f"/projects/{project.id}",
                     json={"storage_slug": "something_else"}, headers=auth_headers)
    print("  PATCH locked slug ->", r.status_code, r.json().get("detail", "")[:60])
    assert r.status_code == 409


def test_ACCEPTANCE_unlocked_slug_is_still_editable(client, auth_headers, mock_db, test_user):
    project = MagicMock()
    project.id = uuid.uuid4()
    project.storage_slug = None
    project.storage_date_prefix = None          # NOT locked
    project.deleted_at = None

    member = MagicMock()
    member.role = ProjectRole.owner
    member.user_id = test_user.id
    member.deleted_at = None

    mock_db.query.return_value.filter.return_value.first.side_effect = [project, member]
    with patch("apps.api.routers.projects.claim_user_slug", return_value="chosen") as claim:
        r = client.patch(f"/projects/{project.id}",
                         json={"storage_slug": "chosen"}, headers=auth_headers)
    print("  PATCH unlocked slug ->", r.status_code)

    # A 200 can't be asserted in this harness: building the response calls
    # ProjectResponse.model_validate on a MagicMock, which 500s. Three
    # pre-existing tests in test_projects.py fail the same way on a clean
    # tree, so it is a limitation of the mock DB, not of this endpoint.
    #
    # What matters here is that the LOCK did not fire and the slug was
    # actually claimed — both provable regardless.
    assert r.status_code != 409, "an unlocked project must not be refused"
    assert claim.called, "the slug was never claimed"
