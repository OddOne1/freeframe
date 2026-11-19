"""Proof tests for suspected share-link holes (security/share-link-proof-tests).

Each test asserts the SAFE behaviour. A test that fails proves the hole; the
failing ones are marked `xfail(strict=True)` so the suite stays green today
and turns red (XPASS) the moment the hole is closed, which is the signal to
drop the marker.

    A  secure-visibility link, anonymous caller, every public endpoint
    B  GET /share/{token}/details as a plain project viewer
    C  is_public project, logged-in NON-member lists folders and assets
       (documents current behaviour; not called a hole)
    D  folder-scoped link, asking for a SIBLING folder outside it
    E  revoked and expired link, every public endpoint

How the DB is mocked
--------------------
The conftest `client` + `mock_db` pair, with `mock_db.query` routed by model
(the same `db.query.side_effect = ...` move test_download_proxy.py uses) to a
small in-memory store, `_Store` below. The store evaluates simple column
predicates (`==`, `!=`, `IS [NOT] NULL`, `IN`, `<`/`>`, `and_`/`or_`), so
"the link row is soft-deleted" and "this folder is not under that one" are
decided by the real route code reading real rows — a plain MagicMock answers
every `.first()` with the same object and cannot express either.

Anything it cannot evaluate (EXISTS subqueries, joins to another table) it
treats as satisfied. That is the PERMISSIVE direction: it can make a route
return more than a real database would, never less, so it cannot turn a
leak into a false PASS.

What is NEVER patched: the gates under test — `validate_share_link`,
`validate_share_link_with_session`, `_validate_asset_in_share`,
`asset_is_in_share_scope`, `validate_asset_in_share`, `require_project_role`,
`get_project_member`, `is_public_project`. A fix placed in any of them
reaches these tests. What IS patched sits strictly below the gate: task
dispatch, the zip build/poll machinery, the rate limiters (which talk to
Redis), and in C the asset-response builder (correlated subqueries).

Every A/E endpoint has a CONTROL case (`TestControls`) that sends the same
request on an ordinary public, live link and requires a 2xx. Without it, a
"safe" 4xx in A/E could just be the fixture failing for an unrelated reason.
"""

import collections
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.sql import operators
from sqlalchemy.sql.elements import (
    BinaryExpression,
    BindParameter,
    BooleanClauseList,
    False_,
    Grouping,
    Null,
    True_,
    UnaryExpression,
)
from sqlalchemy.sql.functions import FunctionElement


# ── In-memory store behind mock_db.query ─────────────────────────────────────

_UNKNOWN = object()


def _is_mapped_class(entity) -> bool:
    return isinstance(entity, type) and hasattr(entity, "__table__")


def _attr_key_for(obj, column):
    """Attribute name on `obj` for `column`, or None when the column is not
    one of `obj`'s table's (a join condition, another entity)."""
    table = getattr(column, "table", None)
    if table is None or getattr(table, "name", None) != obj.__table__.name:
        return None
    name = getattr(column, "name", None) or getattr(column, "key", None)
    for prop in sa_inspect(type(obj)).column_attrs:
        if prop.columns[0].name == name:
            return prop.key
    return None


def _side_value(side, obj):
    if isinstance(side, Grouping):
        return _side_value(side.element, obj)
    if isinstance(side, BindParameter):
        return side.effective_value
    if isinstance(side, Null):
        return None
    if isinstance(side, True_):
        return True
    if isinstance(side, False_):
        return False
    key = _attr_key_for(obj, side) if hasattr(side, "table") else None
    if key is None:
        return _UNKNOWN
    return getattr(obj, key)


def _cmp(op, a, b):
    if op is operators.eq:
        return a is not None and b is not None and a == b
    if op is operators.ne:
        return a is not None and b is not None and a != b
    if op is operators.is_:
        return a is None if b is None else a == b
    if op is operators.is_not:
        return a is not None if b is None else a != b
    if op is operators.in_op:
        return a is not None and a in list(b or [])
    if op is operators.not_in_op:
        return a is not None and a not in list(b or [])
    ordering = {
        operators.lt: lambda x, y: x < y,
        operators.le: lambda x, y: x <= y,
        operators.gt: lambda x, y: x > y,
        operators.ge: lambda x, y: x >= y,
    }
    if op in ordering:
        if a is None or b is None:
            return False
        return ordering[op](a, b)
    return _UNKNOWN


def _evaluate(clause, obj):
    """True / False / _UNKNOWN for one criterion against one row."""
    if isinstance(clause, Grouping):
        return _evaluate(clause.element, obj)
    if isinstance(clause, True_):
        return True
    if isinstance(clause, False_):
        return False
    if isinstance(clause, BooleanClauseList):
        results = [_evaluate(c, obj) for c in clause.clauses]
        if clause.operator is operators.and_:
            return not any(r is False for r in results)
        if clause.operator is operators.or_:
            return any(r is True or r is _UNKNOWN for r in results)
        return _UNKNOWN
    if isinstance(clause, UnaryExpression) and clause.operator is operators.inv:
        inner = _evaluate(clause.element, obj)
        return _UNKNOWN if inner is _UNKNOWN else (not inner)
    if isinstance(clause, BinaryExpression):
        left = _side_value(clause.left, obj)
        right = _side_value(clause.right, obj)
        if left is _UNKNOWN or right is _UNKNOWN:
            return _UNKNOWN
        return _cmp(clause.operator, left, right)
    return _UNKNOWN


def _first_column(expr):
    """The first table-bound column inside a SQL function, e.g. count(Asset.id)."""
    if getattr(expr, "table", None) is not None and hasattr(expr, "name"):
        return expr
    for child in expr.get_children():
        found = _first_column(child)
        if found is not None:
            return found
    return None


class _Query:
    def __init__(self, store, entities):
        self.store = store
        self.entities = entities
        self.criteria = []
        self.kw = {}
        self._offset = 0
        self._limit = None
        self.cls = None
        self.mode = "multi"
        self.columns = []
        self.func = None

        if len(entities) == 1 and _is_mapped_class(entities[0]):
            self.cls, self.mode = entities[0], "entity"
        elif entities and all(hasattr(e, "class_") and hasattr(e, "key") for e in entities):
            classes = {e.class_ for e in entities}
            if len(classes) == 1:
                self.cls, self.mode = classes.pop(), "columns"
                self.columns = [e.key for e in entities]
        elif len(entities) == 1 and isinstance(entities[0], FunctionElement):
            self.mode, self.func = "func", entities[0]
            col = _first_column(entities[0])
            if col is not None:
                self.cls = store.class_for_table(col.table.name)

    def _copy(self):
        q = _Query.__new__(_Query)
        q.__dict__.update(self.__dict__)
        q.criteria = list(self.criteria)
        q.kw = dict(self.kw)
        return q

    # chainable modifiers
    def filter(self, *criteria):
        q = self._copy()
        q.criteria.extend(criteria)
        return q

    def filter_by(self, **kw):
        q = self._copy()
        q.kw.update(kw)
        return q

    def select_from(self, entity):
        q = self._copy()
        if q.cls is None and _is_mapped_class(entity):
            q.cls = entity
        return q

    def offset(self, n):
        q = self._copy()
        q._offset = n or 0
        return q

    def limit(self, n):
        q = self._copy()
        q._limit = n
        return q

    def _same(self, *a, **k):
        return self._copy()

    order_by = join = outerjoin = options = distinct = group_by = _same
    with_for_update = execution_options = having = _same

    # terminal
    def _rows(self):
        if self.cls is None:
            return []
        out = []
        for obj in self.store.rows.get(self.cls, []):
            if any(_evaluate(c, obj) is False for c in self.criteria):
                continue
            if any(getattr(obj, k) != v for k, v in self.kw.items()):
                continue
            out.append(obj)
        out = out[self._offset:]
        if self._limit is not None:
            out = out[: self._limit]
        return out

    def _shape(self, obj):
        if self.mode == "columns":
            Row = collections.namedtuple("Row", self.columns)
            return Row(*(getattr(obj, c) for c in self.columns))
        return obj

    def all(self):
        if self.mode == "multi":
            return []
        return [self._shape(o) for o in self._rows()]

    def __iter__(self):
        return iter(self.all())

    def first(self):
        rows = self.all()
        return rows[0] if rows else None

    def one_or_none(self):
        return self.first()

    def one(self):
        row = self.first()
        if row is None:
            raise LookupError("no row")
        return row

    def count(self):
        return len(self._rows())

    def scalar(self):
        if self.mode == "func":
            if getattr(self.func, "name", "") == "count":
                return len(self._rows())
            return 0
        row = self.first()
        if row is None:
            return None
        return row[0] if self.mode == "columns" else row

    def delete(self, *a, **k):
        return 0

    def update(self, *a, **k):
        return 0


class _Store:
    def __init__(self):
        self.rows = collections.defaultdict(list)
        from apps.api.database import Base

        self._by_table = {m.local_table.name: m.class_ for m in Base.registry.mappers}

    def class_for_table(self, name):
        return self._by_table.get(name)

    def _defaults(self, obj):
        """What an INSERT would have filled: Python-side column defaults, and
        a timestamp for created_at/updated_at (server-side `now()`)."""
        now = datetime.now(timezone.utc)
        for prop in sa_inspect(type(obj)).column_attrs:
            col = prop.columns[0]
            if getattr(obj, prop.key) is not None:
                continue
            if col.default is not None:
                if col.default.is_callable:
                    setattr(obj, prop.key, col.default.arg(None))
                elif col.default.is_scalar:
                    setattr(obj, prop.key, col.default.arg)
            elif prop.key in ("created_at", "updated_at"):
                setattr(obj, prop.key, now)

    def put(self, obj):
        self._defaults(obj)
        self.rows[type(obj)].append(obj)
        return obj

    def add(self, obj):
        bucket = self.rows[type(obj)]
        if not any(o is obj for o in bucket):
            bucket.append(obj)

    def flush(self, *a, **k):
        for bucket in self.rows.values():
            for obj in bucket:
                self._defaults(obj)

    def query(self, *entities):
        return _Query(self, entities)


def _wire(mock_db, store):
    mock_db.query.side_effect = store.query
    mock_db.add.side_effect = store.add
    mock_db.flush.side_effect = store.flush
    mock_db.commit.side_effect = store.flush
    mock_db.refresh.side_effect = lambda *a, **k: store.flush()


# ── The world ────────────────────────────────────────────────────────────────

SECRET_ASSET = "shared-clip-SECRET.mov"
SIBLING_ASSET = "sibling-clip-OUTSIDE.mov"
PUBLIC_NOTE = "a public note on the shared clip"
LINK_PASSWORD = "correct-horse-battery"


def _asset_with_media(store, *, name, project, folder, owner):
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
    )

    asset = store.put(Asset(
        id=uuid.uuid4(), name=name, project_id=project.id, folder_id=folder.id,
        asset_type=AssetType.video, created_by=owner.id,
        description="desc", rating=3, keywords=["k"],
    ))
    version = store.put(AssetVersion(
        id=uuid.uuid4(), asset_id=asset.id, version_number=1,
        processing_status=ProcessingStatus.ready, created_by=owner.id,
    ))
    store.put(MediaFile(
        id=uuid.uuid4(), version_id=version.id, file_type=FileType.video,
        original_filename=name, mime_type="video/quicktime",
        file_size_bytes=1234, s3_key_raw=f"raw/{asset.id}.mov",
        s3_key_processed=f"processed/{asset.id}/master.m3u8",
        s3_key_thumbnail=f"thumbs/{asset.id}.jpg",
        technical_metadata={"video_codec": "prores"},
    ))
    return asset, version


@pytest.fixture
def world(mock_db):
    """Project P > folder Root > {Shared F, Sibling S}, one asset in each.

    `link` is a folder link onto F. Tests set its visibility / deleted_at /
    expires_at as their case needs.
    """
    from apps.api.models.comment import Comment
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project
    from apps.api.models.share import FieldsVisibility, ShareLink, SharePermission
    from apps.api.models.user import User
    from apps.api.models.zip_export import ZipExport

    store = _Store()
    _wire(mock_db, store)

    owner = store.put(User(
        id=uuid.uuid4(), email="owner@example.com", first_name="Olive",
        last_name="Owner", password_hash="x",
    ))
    project = store.put(Project(
        id=uuid.uuid4(), name="P", created_by=owner.id, is_public=False,
    ))
    root = store.put(Folder(id=uuid.uuid4(), name="Root", project_id=project.id, parent_id=None, created_by=owner.id))
    shared = store.put(Folder(id=uuid.uuid4(), name="Shared F", project_id=project.id, parent_id=root.id, created_by=owner.id))
    sibling = store.put(Folder(id=uuid.uuid4(), name="Sibling S", project_id=project.id, parent_id=root.id, created_by=owner.id))

    asset, version = _asset_with_media(store, name=SECRET_ASSET, project=project, folder=shared, owner=owner)
    sib_asset, _ = _asset_with_media(store, name=SIBLING_ASSET, project=project, folder=sibling, owner=owner)

    store.put(Comment(
        id=uuid.uuid4(), asset_id=asset.id, version_id=version.id, parent_id=None,
        author_id=owner.id, body=PUBLIC_NOTE, visibility="public",
    ))

    link = store.put(ShareLink(
        id=uuid.uuid4(), token=f"tok-{uuid.uuid4().hex}", folder_id=shared.id,
        created_by=owner.id, title="Review", is_enabled=True, expires_at=None,
        password_hash=None, password_encrypted=None,
        permission=SharePermission.comment, visibility="public",
        allowed_download_variants=["raw", "proxy_720p"],
        fields_visibility=FieldsVisibility.basic, show_versions=True,
        show_comments=True, show_internal_comments=False, show_watermark=False,
        appearance={"layout": "grid", "theme": "dark", "accent_color": None,
                    "open_in_viewer": True, "sort_by": "created_at"},
    ))
    zip_export = store.put(ZipExport(id=uuid.uuid4(), share_link_id=link.id))

    return {
        "store": store, "owner": owner, "project": project, "root": root,
        "shared": shared, "sibling": sibling, "asset": asset, "version": version,
        "sib_asset": sib_asset, "link": link, "zip": zip_export,
    }


@pytest.fixture
def below_the_gate():
    """Stubs for work that happens AFTER every access check: Celery dispatch,
    the zip builder and poller, and the two Redis-backed rate limiters."""
    def zip_payload(db, export, **k):
        return {"export_id": str(export.id), "status": "ready"}

    class _Export:
        def __init__(self):
            self.id = uuid.uuid4()

    with patch("apps.api.routers.share.send_task_safe"), \
         patch("apps.api.routers.share._resolve_zip_selection",
               side_effect=lambda db, **k: (object(), [{"asset_id": "x"}])), \
         patch("apps.api.routers.share._start_or_reuse_zip",
               side_effect=lambda db, **k: (_Export(), False)), \
         patch("apps.api.routers.share._zip_status_payload", side_effect=zip_payload), \
         patch("apps.api.routers.share._resolve_if_stale"), \
         patch("apps.api.routers.share._advance_preparation"), \
         patch("apps.api.middleware.rate_limit.check_rate_limit", return_value=(True, 0)), \
         patch("apps.api.middleware.global_rate_limit.GlobalRateLimitMiddleware._check",
               return_value=(True, 0)):
        yield


# ── The public share endpoints, as (method, path, kwargs) builders ───────────

def _public_endpoints(w):
    t = w["link"].token
    a = w["asset"].id
    v = w["version"].id
    return {
        "assets": ("GET", f"/share/{t}/assets", {}),
        "stream": ("GET", f"/share/{t}/stream/{a}", {}),
        "thumbnail": ("GET", f"/share/{t}/thumbnail/{a}", {}),
        "export-start": ("POST", f"/share/{t}/export/{a}", {"params": {"variant": "proxy_720p"}}),
        "export-poll": ("GET", f"/share/{t}/export/{a}/{uuid.uuid4()}",
                        {"params": {"variant": "proxy_720p", "version_id": str(v)}}),
        "zip-options": ("POST", f"/share/{t}/zip/options", {"json": {"items": [{"asset_id": str(a)}]}}),
        "zip-start": ("POST", f"/share/{t}/zip", {"json": {"items": [{"asset_id": str(a)}], "variant": "raw"}}),
        "zip-poll": ("GET", f"/share/{t}/zip/{w['zip'].id}", {}),
        "fields": ("GET", f"/share/{t}/fields/{a}", {}),
        "comments-list": ("GET", f"/share/{t}/comments", {"params": {"asset_id": str(a)}}),
        "comment-post": ("POST", f"/share/{t}/comment", {"json": {
            "asset_id": str(a), "body": "guest says hi",
            "guest_email": "guest@example.org", "guest_name": "Gus Guest",
        }}),
    }


ENDPOINTS = [
    "assets", "stream", "thumbnail", "export-start", "export-poll",
    "zip-options", "zip-start", "zip-poll", "fields",
    "comments-list", "comment-post",
]


def _call(client, w, name, headers=None):
    method, path, kwargs = _public_endpoints(w)[name]
    return client.request(method, path, headers=headers or {}, **kwargs)


# ── Controls: the fixture really does reach every endpoint ───────────────────

class TestControls:
    @pytest.mark.parametrize("name", ENDPOINTS)
    def test_a_live_public_link_reaches_the_endpoint(self, client, world, below_the_gate, name):
        resp = _call(client, world, name)
        assert resp.status_code in (200, 201), resp.text


# ── A. secure link, anonymous caller ────────────────────────────────────────

#: What each endpoint hands an anonymous caller on a `secure` link today.
#: `visibility == "secure"` is read by GET /share/{token} alone, which only
#: tells the browser to show a login prompt; no other route checks it.
_A_LEAKS = {
    "assets": "anonymous caller gets the folder listing: asset names, thumbnail URLs, sizes",
    "stream": "anonymous caller gets a playable HLS stream URL for the asset",
    "thumbnail": "anonymous caller gets a signed thumbnail URL",
    "export-start": "anonymous caller can start a proxy render job",
    "export-poll": "anonymous caller gets the signed download URL of a finished export",
    "zip-options": "anonymous caller gets asset names and downloadable variants",
    "zip-start": "anonymous caller can start a zip build of the link's files",
    "zip-poll": "anonymous caller can poll a zip build (download URL once ready)",
    "fields": "anonymous caller gets asset name, description, rating, keywords",
    "comments-list": "anonymous caller reads the link's public comment thread",
    "comment-post": "anonymous caller can post a guest comment (201)",
}


class TestA_SecureLinkRefusesAnonymous:
    @pytest.mark.parametrize("name", [
        pytest.param(n, id=n, marks=pytest.mark.xfail(strict=True, reason=_A_LEAKS[n]))
        for n in ENDPOINTS
    ])
    def test_anonymous_request_is_refused(self, client, world, below_the_gate, name):
        world["link"].visibility = "secure"
        resp = _call(client, world, name)
        assert resp.status_code in (401, 403), (
            f"{name}: secure link served an anonymous caller "
            f"({resp.status_code}): {resp.text[:300]}"
        )


# ── B. /details as a plain project viewer ───────────────────────────────────

class TestB_DetailsDoesNotHandViewersThePassword:
    def test_viewer_does_not_receive_the_password(self, client, world, auth_headers, test_user):
        from apps.api.models.project import ProjectMember, ProjectRole
        from apps.api.services.crypto_service import encrypt_password

        link = world["link"]
        link.password_hash = "$2b$12$notarealhashbutnonempty000000000000000000000000000000"
        link.password_encrypted = encrypt_password(LINK_PASSWORD)
        world["store"].put(ProjectMember(
            id=uuid.uuid4(), project_id=world["project"].id,
            user_id=test_user.id, role=ProjectRole.viewer,
        ))

        resp = client.get(f"/share/{link.token}/details", headers=auth_headers)

        assert resp.status_code in (200, 403), resp.text
        assert LINK_PASSWORD not in resp.text
        if resp.status_code == 200:
            assert resp.json().get("password_value") in (None, "")
            assert "password_encrypted" not in resp.json()


class TestB_WhoMaySeeThePassword:
    """The fix for B: `password_value` goes to the link's creator, the
    project's owner/admin and superadmins only — on /details and on the
    PATCH response, which share one builder. Everyone else reads
    `has_password`."""

    def _protect(self, world):
        from apps.api.services.crypto_service import encrypt_password

        link = world["link"]
        link.password_hash = "$2b$12$notarealhashbutnonempty000000000000000000000000000000"
        link.password_encrypted = encrypt_password(LINK_PASSWORD)
        return link

    def _join(self, world, user, role):
        from apps.api.models.project import ProjectMember, ProjectRole

        world["store"].put(ProjectMember(
            id=uuid.uuid4(), project_id=world["project"].id,
            user_id=user.id, role=ProjectRole(role),
        ))

    @pytest.mark.parametrize("role", ["viewer", "reviewer", "editor"])
    def test_below_admin_gets_has_password_but_not_the_password(
        self, client, world, auth_headers, test_user, role
    ):
        link = self._protect(world)
        self._join(world, test_user, role)
        resp = client.get(f"/share/{link.token}/details", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["has_password"] is True
        assert body["password_value"] is None
        assert LINK_PASSWORD not in resp.text

    @pytest.mark.parametrize("role", ["owner", "admin"])
    def test_project_owner_and_admin_get_the_password(
        self, client, world, auth_headers, test_user, role
    ):
        link = self._protect(world)
        self._join(world, test_user, role)
        body = client.get(f"/share/{link.token}/details", headers=auth_headers).json()
        assert body["has_password"] is True
        assert body["password_value"] == LINK_PASSWORD

    def test_link_creator_gets_the_password_even_as_a_viewer(
        self, client, world, auth_headers, test_user
    ):
        link = self._protect(world)
        link.created_by = test_user.id
        self._join(world, test_user, "viewer")
        body = client.get(f"/share/{link.token}/details", headers=auth_headers).json()
        assert body["password_value"] == LINK_PASSWORD

    def test_superadmin_gets_the_password(self, client, world, auth_headers, test_user):
        from apps.api.models.user import UserGlobalRole

        link = self._protect(world)
        test_user.role = UserGlobalRole.superadmin
        self._join(world, test_user, "viewer")
        body = client.get(f"/share/{link.token}/details", headers=auth_headers).json()
        assert body["password_value"] == LINK_PASSWORD

    def test_has_password_is_false_without_a_passphrase(
        self, client, world, auth_headers, test_user
    ):
        self._join(world, test_user, "owner")
        body = client.get(f"/share/{world['link'].token}/details", headers=auth_headers).json()
        assert body["has_password"] is False
        assert body["password_value"] is None

    def test_a_removed_member_is_refused_outright(self, client, world, auth_headers, test_user):
        """No membership row at all: the /details gate itself answers 403."""
        link = self._protect(world)
        resp = client.get(f"/share/{link.token}/details", headers=auth_headers)
        assert resp.status_code == 403
        assert LINK_PASSWORD not in resp.text

    def test_patch_response_follows_the_same_rule_for_an_editor(
        self, client, world, auth_headers, test_user
    ):
        link = self._protect(world)
        self._join(world, test_user, "editor")
        resp = client.patch(f"/share/{link.token}", json={"title": "Renamed"}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["has_password"] is True
        assert resp.json()["password_value"] is None
        assert LINK_PASSWORD not in resp.text

    def test_patch_response_still_carries_it_for_the_owner(
        self, client, world, auth_headers, test_user
    ):
        link = self._protect(world)
        self._join(world, test_user, "owner")
        resp = client.patch(f"/share/{link.token}", json={"title": "Renamed"}, headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["password_value"] == LINK_PASSWORD


# ── C. public project, logged-in non-member (documents behaviour) ───────────

class TestC_PublicProjectNonMember:
    """Not a hole claim. `is_public=True` is documented in permissions.py as
    "any authenticated user can view"; these pin what that currently means
    for the two listings, so a change to it is a visible decision."""

    def test_non_member_lists_folders_of_a_public_project(self, client, world, auth_headers):
        world["project"].is_public = True
        resp = client.get(f"/projects/{world['project'].id}/folders", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        names = {f["name"] for f in resp.json()}
        assert {"Root", "Shared F", "Sibling S"} <= names

    def test_non_member_lists_assets_of_a_public_project(self, client, world, auth_headers):
        """`_build_asset_responses_bulk` is stubbed: it runs AFTER the access
        decision and is built from correlated subqueries the store cannot
        run. The stub records which rows the route selected, which is the
        thing this test documents."""
        world["project"].is_public = True
        selected = []

        def capture(assets, db, current_user=None):
            selected.extend(assets)
            return []

        with patch("apps.api.routers.assets._build_asset_responses_bulk", side_effect=capture):
            resp = client.get(
                f"/projects/{world['project'].id}/assets",
                params={"folder_id": str(world["sibling"].id)},
                headers=auth_headers,
            )
        assert resp.status_code == 200, resp.text
        assert [a.name for a in selected] == [SIBLING_ASSET]

    def test_a_private_project_refuses_the_same_non_member(self, client, world, auth_headers):
        """The control: membership really is what is being bypassed."""
        resp = client.get(f"/projects/{world['project'].id}/folders", headers=auth_headers)
        assert resp.status_code == 403, resp.text


# ── D. folder link, sibling folder outside it ───────────────────────────────
#
# No CONTENT leaks here — each test checks that first, and that part holds.
# What fails is the status: 403 with "...not within the shared folder"
# where an unknown id gets 404, so a token holder can tell a real folder or
# asset id elsewhere in the project from a random one. The share-comment
# routes already answer 404 for this (permissions.SHARE_NOT_FOUND, §234).

_D_REASON = "403 not 404 for an id outside the shared folder: no content, but confirms the id exists"


class TestD_FolderLinkStaysInsideItsFolder:
    @pytest.mark.xfail(strict=True, reason=_D_REASON)
    def test_listing_a_sibling_folder_is_404(self, client, world, below_the_gate):
        t = world["link"].token
        resp = client.get(f"/share/{t}/assets", params={"folder_id": str(world["sibling"].id)})
        assert SIBLING_ASSET not in resp.text
        assert resp.status_code == 404, resp.text

    @pytest.mark.xfail(strict=True, reason=_D_REASON)
    def test_streaming_a_sibling_asset_is_404(self, client, world, below_the_gate):
        t = world["link"].token
        resp = client.get(f"/share/{t}/stream/{world['sib_asset'].id}")
        assert "url" not in resp.json()
        assert resp.status_code == 404, resp.text

    @pytest.mark.xfail(strict=True, reason=_D_REASON)
    def test_thumbnail_of_a_sibling_asset_is_404(self, client, world, below_the_gate):
        t = world["link"].token
        resp = client.get(f"/share/{t}/thumbnail/{world['sib_asset'].id}")
        assert "url" not in resp.json()
        assert resp.status_code == 404, resp.text


# ── E. revoked and expired links ────────────────────────────────────────────

class TestE_DeadLinksServeNothing:
    @pytest.mark.parametrize("name", ENDPOINTS)
    def test_revoked_link_is_404(self, client, world, below_the_gate, name):
        """Revoked = DELETE /share/{token}, which stamps `deleted_at`."""
        world["link"].deleted_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        resp = _call(client, world, name)
        assert resp.status_code == 404, resp.text

    @pytest.mark.parametrize("name", ENDPOINTS)
    def test_expired_link_is_410(self, client, world, below_the_gate, name):
        world["link"].expires_at = datetime.now(timezone.utc) - timedelta(days=1)
        resp = _call(client, world, name)
        assert resp.status_code == 410, resp.text
