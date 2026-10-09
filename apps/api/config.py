import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# Find .env file - check current dir, then project root
# __file__ = apps/api/config.py, so parent.parent = project root
def _find_env_file() -> str:
    project_root = Path(__file__).parent.parent.parent  # freeframe/
    candidates = [
        Path(".env"),
        Path(".env.local"),
        project_root / ".env",
        project_root / ".env.local",
    ]
    for p in candidates:
        if p.exists():
            return str(p.resolve())
    return ".env"

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_find_env_file(),
        env_file_encoding="utf-8",
        extra="ignore"  # Ignore extra env vars not in model
    )

    database_url: str
    redis_url: str
    s3_storage: str = "minio"  # "s3" for AWS S3, "minio" for local MinIO
    s3_bucket: str = "freeframe"
    s3_endpoint: str = "http://minio:9000"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_region: str = "us-east-1"
    s3_public_endpoint: str | None = None  # External URL for presigned URLs (e.g. http://localhost:9000 when S3_ENDPOINT is http://minio:9000)

    # §213 — the per-part ceiling, and the ONLY value that decides the
    # maximum uploadable file size (10,000 parts x this).
    #
    # 90 MiB because part PUTs currently go to S3_PUBLIC_ENDPOINT through
    # Cloudflare's free tier, which returns HTTP 413 for a 150 MB body
    # (measured). AIStor itself allows 5 TiB per part. Once §214 moves
    # uploads off that route, raising THIS ONE VALUE is the whole change —
    # see services/upload_policy.py.
    upload_max_part_bytes: int = 90 * 1024 * 1024

    # Optional operator-chosen LOWER bound on file size. Unset means "as
    # large as the part arithmetic allows". It can only reduce the ceiling,
    # never raise it above what 10,000 parts can cover — the pre-§213
    # MAX_FILE_SIZE_BYTES = 2000 GiB was exactly that kind of promise, and
    # the client died at part 10,001 keeping it.
    upload_max_file_bytes: int | None = None

    # ── §215 — reaping abandoned uploads ────────────────────────────────
    #
    # §213 made a failed upload KEEP its multipart session so it can be
    # resumed. That is the point, and it means abandoned uploads otherwise
    # accumulate forever: parts billed as storage and invisible in the app,
    # plus versions stuck at `uploading`. An earlier incident left 92.3 GiB
    # of orphaned parts and five ghost rows.

    # How long NOTHING may happen before an upload counts as abandoned.
    #
    # Measured from the newest part's LastModified (falling back to
    # Initiated), NOT from when the upload started — a 100 GB offload that
    # began three weeks ago and sent a part two minutes ago is alive.
    #
    # 14 days is deliberately generous. Reaping costs the user every byte
    # already sent: a resume against a reaped session is safe (§213 treats
    # NoSuchUpload as "start a fresh upload") but starts from zero. A user
    # may pause for days, and the desktop app resumes across quits and
    # reboots. Lower it only with that cost in mind.
    upload_abandon_days: int = 14

    # Pass 2's grace period: how old an `uploading` row must be before the
    # absence of a store-side upload is read as "ghost" rather than "just
    # started". /upload/initiate creates the multipart upload BEFORE it
    # commits the row, so the only window is between those two statements —
    # milliseconds. 24h is far beyond any version of that race.
    upload_ghost_grace_hours: int = 24

    # Off switches, for the first real run against a live bucket.
    upload_sweep_enabled: bool = True
    # Does everything except the aborts and the status writes, and logs
    # exactly what it WOULD have done.
    upload_sweep_dry_run: bool = False

    # Per-run ceiling on aborts, so a surprise (a misconfigured prefix, a
    # clock skew) cannot empty the bucket in one tick. The remainder waits
    # for the next hourly run.
    upload_sweep_max_aborts: int = 50
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7
    frontend_url: str = "http://localhost:3000"
    transcoder_engine: str = "ffmpeg"
    
    # Worker concurrency settings
    transcoding_concurrency: int = 2  # Number of concurrent video transcoding jobs
    email_concurrency: int = 2  # Number of concurrent email sending jobs
    # 1 by default on purpose: CPU Whisper jobs are heavy, and running them
    # in parallel just makes them compete for the same cores the HLS
    # transcodes are already using.
    transcription_concurrency: int = 1

    # §114 -- how long a version may sit at `processing` without its
    # updated_at moving before the sweeper calls it dead.
    #
    # It is a silence threshold, not a duration limit: the progress callback
    # touches the row on every new whole percent, so a real transcode of any
    # length keeps resetting the clock. 45 minutes is therefore generous
    # against a worker that is alive but slow, while still clearing an
    # orphaned row inside the hour. Override with STUCK_PROCESSING_MINUTES.
    stuck_processing_minutes: int = 45

    # §219 -- the SECOND, much longer threshold, for a version that is at
    # `processing` but has never actually started (processing_started_at IS
    # NULL).
    #
    # The 45-minute rule above only applies once a worker has really begun
    # the work. A queued version has nothing touching its row at all -- the
    # status is set at dispatch and the progress callback cannot run yet --
    # so measuring silence against it is meaningless, and doing so failed
    # two 95 GiB originals that were waiting their turn behind a 641 GiB
    # import.
    #
    # This is the backstop for the case that remains real: a task lost from
    # the broker entirely, where nothing will ever pick the row up. A week
    # is deliberately far longer than any legitimate queue wait -- the point
    # is that such a row is eventually visible as failed rather than
    # spinning forever, not that it is reaped promptly. Override with
    # STUCK_QUEUED_HOURS.
    stuck_queued_hours: int = 168

    # §219 -- how long Redis hides a delivered message before deciding the
    # worker is gone and handing it to someone else.
    #
    # The Redis transport's own default is 3600. Combined with
    # `task_acks_late=True` -- which means a long task stays unacked for its
    # whole run -- that is a duplicate-execution bug, not a tuning
    # parameter: any transcode still encoding after an hour is restored to
    # the queue and started AGAIN on the next free slot, while the first one
    # is still writing to the same deterministic S3 prefix. Observed on the
    # live server: the same task id active twice on one worker.
    # `process_asset`'s idempotency guard cannot help, because it only skips
    # `ready`, and a version that is still being encoded is `processing`.
    #
    # 43200 (12 h) is chosen against the real worst case rather than picked
    # round: ONE `process_asset` can run the HLS ladder (4 h timeout) and
    # then the 1080p download proxy (another 4 h timeout) in sequence, with
    # the full-size EXIF download and the ladder upload on top. That is
    # ~8 h of ffmpeg ceilings alone, so 12 h leaves real margin while still
    # being a finite backstop. tests assert this stays above every timeout
    # and task time limit in the codebase. Override with
    # CELERY_VISIBILITY_TIMEOUT_SECONDS.
    celery_visibility_timeout_seconds: int = 43200

    # Speech-to-text (faster-whisper, CPU-only -- see CLAUDE.md).
    # MUST stay a multilingual checkpoint: the ".en" variants (small.en etc.)
    # exist and would silently break every non-English upload.
    whisper_model_size: str = "small"
    whisper_compute_type: str = "int8"  # int8 is the sane CPU default; float32 is far slower

    # Email settings - supports AWS SES or any SMTP server
    # If mail_provider is "ses", uses AWS SES with aws_mail_* credentials
    # If mail_provider is "smtp", uses standard SMTP with smtp_* settings
    mail_provider: str = "ses"  # "ses" or "smtp"
    mail_from_address: str = "noreply@example.com"
    mail_from_name: str = "FreeFrame"
    
    # AWS SES settings
    aws_mail_access_key_id: str | None = None
    aws_mail_secret_access_key: str | None = None
    aws_mail_region: str = "ap-south-1"
    
    # SMTP settings (for non-SES providers like SendGrid, Mailgun, self-hosted)
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_use_tls: bool = True
    # §199 — "starttls" | "implicit_tls" | "none". None (unset) means "derive
    # it from smtp_use_tls", which is what keeps every existing .env.prod
    # working untouched. See services/email_config.smtp_security_from.
    smtp_security: str | None = None

settings = Settings()
