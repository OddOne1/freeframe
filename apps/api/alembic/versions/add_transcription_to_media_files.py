"""add speech-to-text columns to media_files

Revision ID: add_transcription_to_media_files
Revises: add_platform_storage_limit
Create Date: 2026-07-30

"""
from alembic import op
import sqlalchemy as sa

revision = 'add_transcription_to_media_files'
down_revision = 'add_platform_storage_limit'
branch_labels = None
depends_on = None


def upgrade() -> None:
    transcriptionstatus = sa.Enum(
        'not_started', 'processing', 'ready', 'failed', name='transcriptionstatus'
    )
    transcriptionstatus.create(op.get_bind())

    op.add_column('media_files', sa.Column('s3_key_transcript', sa.String(length=1000), nullable=True))
    op.add_column('media_files', sa.Column('s3_key_captions', sa.String(length=1000), nullable=True))
    op.add_column('media_files', sa.Column('transcript_language', sa.String(length=10), nullable=True))
    # server_default seeds every existing row to not_started as well as new
    # ones -- there is no backfill to do beyond that, since nothing has ever
    # been transcribed before this migration. Note this is a plain literal on
    # an enum-typed column via add_column (not raw SQL), so the explicit
    # ::transcriptionstatus cast the CLAUDE.md hard rule warns about is not
    # needed here -- Alembic emits it as a typed DEFAULT, not a bare string
    # comparison. Any *later* raw-SQL UPDATE touching this column still needs
    # the cast.
    op.add_column(
        'media_files',
        sa.Column(
            'transcription_status',
            transcriptionstatus,
            nullable=False,
            server_default='not_started',
        ),
    )


def downgrade() -> None:
    op.drop_column('media_files', 'transcription_status')
    op.drop_column('media_files', 'transcript_language')
    op.drop_column('media_files', 's3_key_captions')
    op.drop_column('media_files', 's3_key_transcript')
    sa.Enum(name='transcriptionstatus').drop(op.get_bind())
