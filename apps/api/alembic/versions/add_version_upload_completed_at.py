"""asset_versions.upload_completed_at — an unfinished upload is not a processing failure (§238).

One nullable timestamptz, plus a careful, idempotent, data-only backfill.

── Why the column exists ─────────────────────────────────────────────────
`processing_status = 'failed'` covers two situations the UI has to answer
differently: an upload that never finished (nothing to process, "Restart
processing" is meaningless, the empty row may be removed without burning
its version number) and a transcode that failed with every byte safely in
the bucket (retryable, and its number stays retired when it is deleted).
Nothing in the schema could tell them apart. See
`AssetVersion.failure_stage` for why `processing_started_at IS NULL` is NOT
that test: tasks/transcode_tasks.py fails a version at two points before
it stamps that column, and /upload/complete clears it to NULL on every
dispatch (§219).

── The backfill ──────────────────────────────────────────────────────────
Three independent proofs that an upload DID complete, OR'd together, all
of them evidence this schema already holds:

  1. `processing_status IN ('processing','ready')` — the status itself.
     Only /upload/complete, the retry route and the transcoder write
     those, and all three are downstream of a finished upload.
  2. `processing_started_at IS NOT NULL` — a transcode worker actually
     picked the version up (§219), which cannot happen before completion.
  3. its `media_files.size_verified_at IS NOT NULL` — §180's reconcile,
     which runs INSIDE the completing transaction and nowhere else. This
     is the one that rescues history: a version that completed and later
     failed in the transcoder has nothing in 1 or 2 to show for it, and
     this column is the best proof left that its bytes landed.

The value written is `COALESCE(processing_started_at, updated_at)` — the
closest timestamp this schema has to "when the upload finished", never a
fabricated `now()`, so a row's own history stays readable.

Everything else keeps NULL, which reads as "no upload of this version ever
completed". That is the safe direction: a NULL on a `failed` row makes the
app offer Delete instead of Restart, and the row is only ever hard-deleted
after a live HEAD proves the object is not there.

IDEMPOTENT: the UPDATE is guarded by `upload_completed_at IS NULL`, so
running it twice writes nothing the second time. It is also re-runnable
after the column exists — see `_backfill()`.

Counts for each class are logged (as §235's migration does), so the owner
can compare what ran against what the read-only SELECT in the §238 report
predicted.

Revision ID: add_version_upload_completed_at
Revises: share_internal_comments
"""
import logging

from alembic import op
import sqlalchemy as sa

revision = 'add_version_upload_completed_at'
down_revision = 'share_internal_comments'
branch_labels = None
depends_on = None

logger = logging.getLogger("alembic.runtime.migration")

#: The three proofs, as one SQL predicate. Written once and used for both
#: the counts and the UPDATE so the reported numbers cannot describe a
#: different set of rows from the one that was touched.
_COMPLETED_PREDICATE = """
    av.upload_completed_at IS NULL
    AND (
        av.processing_status IN ('processing', 'ready')
        OR av.processing_started_at IS NOT NULL
        OR EXISTS (
            SELECT 1 FROM media_files mf
            WHERE mf.version_id = av.id AND mf.size_verified_at IS NOT NULL
        )
    )
"""


def _backfill() -> None:
    conn = op.get_bind()

    # Counted BEFORE the write, per class, and the classes OVERLAP on
    # purpose — a `ready` row usually satisfies all three. The numbers are
    # for recognising the data, not for adding up.
    classes = conn.execute(sa.text(f"""
        SELECT
            COUNT(*) FILTER (
                WHERE av.processing_status IN ('processing', 'ready')
            ) AS by_status,
            COUNT(*) FILTER (WHERE av.processing_started_at IS NOT NULL)
                AS by_started,
            COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM media_files mf
                WHERE mf.version_id = av.id AND mf.size_verified_at IS NOT NULL
            )) AS by_size_verified,
            COUNT(*) AS total
        FROM asset_versions av
        WHERE {_COMPLETED_PREDICATE}
    """)).one()

    left_null = conn.execute(sa.text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE processing_status = 'failed') AS failed,
            COUNT(*) FILTER (WHERE processing_status = 'uploading') AS uploading
        FROM asset_versions av
        WHERE NOT (""" + _COMPLETED_PREDICATE + """)
          AND av.upload_completed_at IS NULL
    """)).one()

    result = conn.execute(sa.text(f"""
        UPDATE asset_versions av
        SET upload_completed_at = COALESCE(av.processing_started_at, av.updated_at)
        WHERE {_COMPLETED_PREDICATE}
    """))

    logger.info(
        "§238 backfill: %d version(s) stamped upload_completed_at "
        "(%d by status processing/ready, %d by processing_started_at, "
        "%d by media_files.size_verified_at; the classes overlap). "
        "%d row(s) left NULL — %d failed, %d uploading.",
        result.rowcount, classes.by_status, classes.by_started,
        classes.by_size_verified, left_null.total, left_null.failed,
        left_null.uploading,
    )


def upgrade():
    op.add_column(
        'asset_versions',
        sa.Column('upload_completed_at', sa.DateTime(timezone=True), nullable=True),
    )
    _backfill()


def downgrade():
    # The column is the only thing added, and every value in it was
    # derived from columns that are still there, so dropping it loses
    # nothing that cannot be recomputed by running this migration again.
    op.drop_column('asset_versions', 'upload_completed_at')
