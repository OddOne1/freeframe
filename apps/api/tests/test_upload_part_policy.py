"""One part-size policy, and a parts list a resume can trust (§213).

Three things are asserted here, and the third is the one that matters
most for the next task:

  a) `plan_parts` arithmetic — every accepted size is covered by parts
     that are legal at the store and number no more than 10,000.
  b) A file above the ceiling is refused with 413 by BOTH initiate
     endpoints, BEFORE any multipart upload is created and before any
     row exists. The pre-§213 code accepted 2000 GB and let the client
     die at part 10,001 after hours of transfer.
  c) Moving `UPLOAD_MAX_PART_BYTES` and nothing else moves the ceiling.
     §214 will do exactly that once part PUTs stop going through
     Cloudflare, and this is the test that says it is a one-value edit.

Fake S3 throughout, same as the other `test_upload_*` files: there is no
real MinIO here, so what is asserted is what the API does with each
answer the store could give, not the store's own behaviour.
"""
import uuid
from unittest.mock import MagicMock, patch

import pytest

from apps.api.services.upload_policy import (
    MIB,
    MIN_PART_BYTES,
    PART_DIVISOR,
    S3_MAX_PARTS,
    S3_MIN_PART_BYTES,
    UploadTooLarge,
    max_file_bytes,
    plan_parts,
)

GIB = 1024 ** 3
DEFAULT_CAP = 90 * MIB


@pytest.fixture(autouse=True)
def _default_cap(monkeypatch):
    """Pin the cap so these tests describe the shipped default, not .env."""
    from apps.api import config

    monkeypatch.setattr(config.settings, "upload_max_part_bytes", DEFAULT_CAP, raising=False)
    monkeypatch.setattr(config.settings, "upload_max_file_bytes", None, raising=False)


# ── a — the arithmetic ─────────────────────────────────────────────────────


def _assert_invariants(size, plan):
    assert plan.part_size <= DEFAULT_CAP, "a part above the cap would 413 at the proxy"
    assert plan.total_parts <= S3_MAX_PARTS
    assert plan.part_size * plan.total_parts >= size, "some bytes have no part"
    assert (plan.total_parts - 1) * plan.part_size < size, "a part would be empty"
    if plan.total_parts > 1:
        assert plan.part_size >= S3_MIN_PART_BYTES, "multi-part uploads need >= 5 MiB parts"


@pytest.mark.parametrize(
    "size",
    [
        1,
        16 * MIB,
        16 * MIB + 1,
        148 * GIB,
        200 * GIB,
        500 * GIB,
        S3_MAX_PARTS * DEFAULT_CAP,
    ],
)
def test_every_accepted_size_is_split_legally(size):
    _assert_invariants(size, plan_parts(size))


def test_small_files_keep_small_parts():
    """A failed part costs its own bytes. A 1 MB file must not be planned
    with a 90 MiB part just because that is what the biggest file needs."""
    assert plan_parts(1).part_size == MIN_PART_BYTES
    assert plan_parts(10 * MIB).part_size == MIN_PART_BYTES
    assert plan_parts(50 * GIB).part_size == MIN_PART_BYTES


def test_the_part_size_grows_only_as_much_as_the_part_limit_requires():
    """The 'smallest part that fits' rule, not 'one size for everything'."""
    small = plan_parts(148 * GIB)
    large = plan_parts(500 * GIB)
    assert small.part_size < large.part_size
    # Each is the smallest whole MiB that keeps the count under the divisor.
    for size, plan in ((148 * GIB, small), (500 * GIB, large)):
        assert plan.part_size % MIB == 0
        if plan.part_size > MIN_PART_BYTES:
            one_mib_smaller = plan.part_size - MIB
            assert -(-size // one_mib_smaller) > PART_DIVISOR


def test_exactly_ten_thousand_parts_at_the_cap_is_accepted():
    size = S3_MAX_PARTS * DEFAULT_CAP
    plan = plan_parts(size)
    assert plan.part_size == DEFAULT_CAP
    assert plan.total_parts == S3_MAX_PARTS


def test_one_byte_more_than_the_ceiling_is_refused():
    with pytest.raises(UploadTooLarge):
        plan_parts(S3_MAX_PARTS * DEFAULT_CAP + 1)


def test_the_refusal_names_the_size_and_the_maximum():
    """The message is what a user sees. 'File exceeds 10GB limit' while
    enforcing 2000 GB is the thing this replaces."""
    with pytest.raises(UploadTooLarge) as caught:
        plan_parts(2000 * GIB)
    detail = caught.value.detail
    assert "2000.00 GiB" in detail
    assert f"{max_file_bytes() / GIB:.2f} GiB" in detail
    assert f"{2000 * GIB:,} bytes" in detail


def test_an_operator_may_lower_the_ceiling_but_not_raise_it(monkeypatch):
    from apps.api import config

    monkeypatch.setattr(config.settings, "upload_max_file_bytes", 10 * GIB, raising=False)
    assert max_file_bytes() == 10 * GIB
    with pytest.raises(UploadTooLarge):
        plan_parts(11 * GIB)

    # Above what the part arithmetic can honour, the arithmetic wins.
    monkeypatch.setattr(config.settings, "upload_max_file_bytes", 9000 * GIB, raising=False)
    assert max_file_bytes() == S3_MAX_PARTS * DEFAULT_CAP


# ── c — the ceiling is a config value ──────────────────────────────────────


def test_changing_only_the_part_cap_moves_the_ceiling(monkeypatch):
    """§214's whole edit, proven as one setting.

    512 MiB parts are what the LAN/Traefik route will allow. Nothing else
    in this test changes — no divisor, no floor, no code.
    """
    from apps.api import config

    over = S3_MAX_PARTS * DEFAULT_CAP + 1
    with pytest.raises(UploadTooLarge):
        plan_parts(over)

    monkeypatch.setattr(config.settings, "upload_max_part_bytes", 512 * MIB, raising=False)

    plan = plan_parts(over)
    assert plan.total_parts <= S3_MAX_PARTS
    assert max_file_bytes() == S3_MAX_PARTS * 512 * MIB
    assert max_file_bytes() > 4800 * GIB


def test_a_cap_below_the_stores_minimum_is_clamped_not_honoured(monkeypatch):
    """A mistyped env var must not make every multi-part upload invalid."""
    from apps.api import config

    monkeypatch.setattr(config.settings, "upload_max_part_bytes", 1024, raising=False)
    plan = plan_parts(1 * GIB)
    assert plan.part_size == S3_MIN_PART_BYTES


# ── b — both endpoints refuse, and leave nothing behind ────────────────────


def _initiate_body(project_id, size):
    return {
        "project_id": str(project_id),
        "asset_name": "huge.mxf",
        "original_filename": "huge.mxf",
        "mime_type": "application/mxf",
        "file_size_bytes": size,
    }


class TestAnImpossibleSizeIsRefusedByBothEndpoints:
    OVER = S3_MAX_PARTS * DEFAULT_CAP + 1

    def test_upload_initiate_returns_413_and_creates_nothing(
        self, client, mock_db, auth_headers
    ):
        with patch("apps.api.routers.upload.create_multipart_upload") as create:
            res = client.post(
                "/upload/initiate",
                json=_initiate_body(uuid.uuid4(), self.OVER),
                headers=auth_headers,
            )

        assert res.status_code == 413, res.text
        assert "GiB" in res.json()["detail"]
        create.assert_not_called()
        mock_db.add.assert_not_called()
        mock_db.commit.assert_not_called()

    def test_the_versions_endpoint_returns_413_and_creates_nothing(
        self, client, mock_db, auth_headers
    ):
        asset = MagicMock()
        asset.id = uuid.uuid4()
        asset.project_id = uuid.uuid4()
        mock_db.first.return_value = asset

        with patch("apps.api.routers.assets.create_multipart_upload") as create, patch(
            "apps.api.services.permissions.require_project_role"
        ), patch("apps.api.routers.assets.require_project_role"):
            res = client.post(
                f"/assets/{asset.id}/versions",
                json=_initiate_body(asset.project_id, self.OVER),
                headers=auth_headers,
            )

        assert res.status_code == 413, res.text
        create.assert_not_called()
        mock_db.add.assert_not_called()
        mock_db.commit.assert_not_called()

    def test_a_size_at_the_ceiling_is_not_refused_by_the_policy(self):
        """The paired half: the refusal is about the ceiling, not about
        every large file."""
        plan_parts(S3_MAX_PARTS * DEFAULT_CAP)


# ── GET /upload/parts ──────────────────────────────────────────────────────


S3_KEY = "raw/proj/asset/version/original.mxf"


def _owned(user_id):
    """A MediaFile and the AssetVersion behind it, in lookup order."""
    media_file = MagicMock()
    media_file.s3_key_raw = S3_KEY
    media_file.version_id = uuid.uuid4()
    version = MagicMock()
    version.id = media_file.version_id
    version.created_by = user_id
    return media_file, version


def _pages(total_parts, part_size=16 * MIB, page=1000):
    """`list_parts` responses for an upload of `total_parts` parts."""
    out = []
    for start in range(0, total_parts, page):
        chunk = list(range(start + 1, min(start + page, total_parts) + 1))
        out.append({
            "Parts": [
                {"PartNumber": n, "ETag": f'"e{n}"', "Size": part_size} for n in chunk
            ],
            "IsTruncated": chunk[-1] < total_parts,
            "NextPartNumberMarker": chunk[-1],
        })
    return out


class TestTheServerSaysWhichPartsItAlreadyHas:
    def test_the_owner_gets_the_list(self, client, mock_db, auth_headers, test_user):
        media_file, version = _owned(test_user.id)
        mock_db.first.side_effect = [media_file, version]
        s3 = MagicMock()
        s3.list_parts.side_effect = _pages(3)

        with patch("apps.api.services.s3_service.get_s3_client", return_value=s3):
            res = client.get(
                "/upload/parts",
                params={"s3_key": S3_KEY, "upload_id": "u-1"},
                headers=auth_headers,
            )

        assert res.status_code == 200, res.text
        parts = res.json()["parts"]
        assert [p["PartNumber"] for p in parts] == [1, 2, 3]
        assert all(p["Size"] == 16 * MIB for p in parts)

    def test_every_page_is_returned(self, client, mock_db, auth_headers, test_user):
        """A 6,000-part upload is six pages. Returning the first one makes
        a resuming client re-send 5,000 parts — the exact cost resume
        exists to avoid."""
        media_file, version = _owned(test_user.id)
        mock_db.first.side_effect = [media_file, version]
        pages = _pages(6000)
        assert len(pages) >= 3
        s3 = MagicMock()
        s3.list_parts.side_effect = pages

        with patch("apps.api.services.s3_service.get_s3_client", return_value=s3):
            res = client.get(
                "/upload/parts",
                params={"s3_key": S3_KEY, "upload_id": "u-1"},
                headers=auth_headers,
            )

        parts = res.json()["parts"]
        assert len(parts) == 6000
        assert [p["PartNumber"] for p in parts] == list(range(1, 6001))
        assert s3.list_parts.call_count == len(pages)
        # Each page after the first asked to continue from the last part.
        markers = [c.kwargs.get("PartNumberMarker") for c in s3.list_parts.call_args_list]
        assert markers[0] is None
        assert markers[1:] == [1000, 2000, 3000, 4000, 5000]

    def test_a_listing_that_cannot_be_paged_still_answers_the_client(
        self, client, mock_db, auth_headers, test_user
    ):
        """THE MUTATION LINE for making `list_multipart_parts` strict by
        default, or for asking strictly here (§215a).

        §215's sweep asks strictly because a short list of parts reads to
        it as an abandoned upload. This caller is the opposite: a resuming
        client told about fewer parts than the store holds re-sends some —
        slower, never wrong — whereas a 500 here makes it start a multi-
        hundred-gigabyte upload over. So a truncated page with no usable
        marker must still come back as the parts that were read.
        """
        media_file, version = _owned(test_user.id)
        mock_db.first.side_effect = [media_file, version]
        s3 = MagicMock()
        s3.list_parts.return_value = {
            "Parts": [{"PartNumber": n, "ETag": f'"e{n}"', "Size": 16 * MIB}
                      for n in (1, 2, 3)],
            "IsTruncated": True,          # ...and no NextPartNumberMarker
        }

        with patch("apps.api.services.s3_service.get_s3_client", return_value=s3):
            res = client.get(
                "/upload/parts",
                params={"s3_key": S3_KEY, "upload_id": "u-1"},
                headers=auth_headers,
            )

        assert res.status_code == 200, res.text
        assert [p["PartNumber"] for p in res.json()["parts"]] == [1, 2, 3]
        # Did not spin on the unusable marker either.
        assert s3.list_parts.call_count == 1

    def test_another_users_upload_is_refused(self, client, mock_db, auth_headers):
        media_file, version = _owned(uuid.uuid4())   # somebody else's
        mock_db.first.side_effect = [media_file, version]
        s3 = MagicMock()

        with patch("apps.api.services.s3_service.get_s3_client", return_value=s3):
            res = client.get(
                "/upload/parts",
                params={"s3_key": S3_KEY, "upload_id": "u-1"},
                headers=auth_headers,
            )

        assert res.status_code == 403
        s3.list_parts.assert_not_called()

    def test_an_unknown_key_is_404(self, client, mock_db, auth_headers):
        mock_db.first.return_value = None
        s3 = MagicMock()

        with patch("apps.api.services.s3_service.get_s3_client", return_value=s3):
            res = client.get(
                "/upload/parts",
                params={"s3_key": "raw/nope/original.mov", "upload_id": "u-1"},
                headers=auth_headers,
            )

        assert res.status_code == 404
        s3.list_parts.assert_not_called()

    def test_a_gone_session_comes_back_with_a_stable_code(
        self, client, mock_db, auth_headers, test_user
    ):
        """Clients branch on this to start a FRESH upload instead of
        failing. Branching on prose breaks when the wording changes."""
        from botocore.exceptions import ClientError

        media_file, version = _owned(test_user.id)
        mock_db.first.side_effect = [media_file, version]
        s3 = MagicMock()
        s3.list_parts.side_effect = ClientError(
            {"Error": {"Code": "NoSuchUpload", "Message": "gone"}}, "ListParts"
        )

        with patch("apps.api.services.s3_service.get_s3_client", return_value=s3):
            res = client.get(
                "/upload/parts",
                params={"s3_key": S3_KEY, "upload_id": "u-guessed"},
                headers=auth_headers,
            )

        assert res.status_code == 404
        assert res.json()["detail"]["code"] == "no_such_upload"

    def test_an_unrelated_storage_failure_is_not_reported_as_a_gone_session(
        self, client, mock_db, auth_headers, test_user
    ):
        """A 500 from the store must not make a client throw away a good
        upload and start again from zero."""
        from botocore.exceptions import ClientError

        media_file, version = _owned(test_user.id)
        mock_db.first.side_effect = [media_file, version]
        s3 = MagicMock()
        s3.list_parts.side_effect = ClientError(
            {"Error": {"Code": "InternalError", "Message": "boom"}}, "ListParts"
        )

        with patch("apps.api.services.s3_service.get_s3_client", return_value=s3):
            res = client.get(
                "/upload/parts",
                params={"s3_key": S3_KEY, "upload_id": "u-1"},
                headers=auth_headers,
            )

        assert res.status_code != 404
