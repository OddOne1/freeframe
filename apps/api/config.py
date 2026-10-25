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
    # ── §217 — download links that outlive a bad day ────────────────────
    #
    # How long a link that hands out an ORIGINAL or a BATCH download stays
    # valid. Replaces the hard-coded 24 at every `proxy_url_for` download
    # call site and the 1 on the zip route.
    #
    # 72 rather than 24 because the thing it bounds is now a resumable
    # multi-hour transfer, not a click: a 641 GiB folder at 50 Mbit/s is
    # ~28 h of wall clock, and the old 1-hour zip link meant an interrupted
    # download could not be resumed at all once the token died. The clients
    # can also renew — a 401 on the download URL is answered by re-polling
    # the status endpoint, which re-checks the share link and the session
    # live — so this is the ceiling on how long a LEAKED url keeps working,
    # not on how long a legitimate download may take.
    #
    # WHAT A LEAKED 72 h LINK EXPOSES, stated so the number is chosen
    # knowingly: an originals link is a `create_hls_token` prefix token, so
    # it authorises every object under that asset-version's S3 folder —
    # the original, the HLS ladder, the thumbnail, the persisted 1080p
    # proxy, any sidecar stored there. One asset version, not the project.
    # A streamed-zip link is narrower: it authorises one export id, and
    # every request against it re-validates the share link (enabled,
    # not expired, downloads still permitted, password session still
    # valid) or the in-app creator's project membership, so revoking
    # access kills the link immediately regardless of this setting.
    #
    # Deliberately NOT applied to thumbnails, HLS manifests or segments
    # (playback keeps `proxy_url_for`'s own 24 h default), nor to the
    # graded-LUT export links — those point at an object that
    # `delete_lut_export` removes after exactly one hour, so a longer link
    # would promise access to something already deleted.
    #
    # Override with DOWNLOAD_LINK_HOURS.
    download_link_hours: int = 72

    # ── §217 — CRC-32 of stored objects ────────────────────────────────
    #
    # A ZIP_STORED entry's local header AND the central directory both
    # carry the CRC, so a streamed archive has to know it for every file
    # before it can answer a single Range request. Read once per object,
    # 8 MiB at a time: a camera original is routinely multi-GB and the
    # worker holds one at a time, so the file is never loaded into memory.
    # 8 MiB matches tasks/zip_tasks._CHUNK, which already streams S3
    # bodies at that size on this hardware.
    crc_chunk_bytes: int = 8 * 1024 * 1024

    # How many CRC jobs may run at once across the whole fleet.
    #
    # ONE, and this is the §217 "do not occupy a transcode slot" decision.
    # These tasks are routed to `transcoding`, which is the only queue any
    # container consumes for this kind of work (`worker`, concurrency 2,
    # also the transcoder). A new queue would have needed a new container,
    # and a queue nothing consumes is how `apply_watermark`,
    # `purge_expired_trash` and four zip tasks each silently never ran
    # (§126, §143, §182) — not a risk worth taking for a tidier topology.
    # So: same queue, but a Redis lease caps concurrency at this number, so
    # a CRC pass can never hold BOTH transcode slots and stall the ladder.
    crc_max_concurrent: int = 1

    # How long the lease above is held before Redis expires it, and how
    # often the holder renews it. The task can legitimately run for tens of
    # minutes, so the lease is short and refreshed rather than long and
    # trusted: a worker killed mid-read (every deploy does this) must not
    # block the next CRC job for the rest of the day.
    crc_lease_seconds: int = 300
    crc_lease_refresh_seconds: int = 60

    # Attempts before an object is left alone by the backfill. A missing or
    # permanently unreadable object marks its own entry skipped — exactly
    # as the old build path skipped a member it could not read — rather
    # than being retried on every pass forever.
    crc_max_attempts: int = 3

    # ── §217 — the throttled backfill ──────────────────────────────────
    #
    # The owner's library already holds hundreds of GB with no CRC. The
    # migration does NOT backfill (see the revision's own docstring); this
    # task does, one object per run, re-queueing itself with the pause
    # below until nothing is left. Skips anything already verified, so it
    # is safe to start repeatedly and resumes by itself after a deploy.
    crc_backfill_enabled: bool = True
    crc_backfill_objects_per_run: int = 1
    crc_backfill_pause_seconds: int = 30

    # ── §217 — streaming a zip through the API process ─────────────────
    #
    # A stalled client must not pin an upstream S3 read forever. Two
    # separate ceilings, because they catch different things:
    #
    # `zip_stream_idle_seconds` bounds ONE 1 MiB read from the bucket. A
    # LAN read that takes two minutes is a dead connection, not a slow one.
    #
    # `zip_stream_stall_seconds` bounds the gap between two chunks being
    # TAKEN by the client. A download manager that pauses, or a connection
    # that silently dies without an RST, leaves the response coroutine
    # suspended; once it moves again — or once the gap is noticed — the
    # upstream body is closed and the stream ends rather than being held
    # open for the rest of the token's life. 15 minutes is far longer than
    # any TCP stall a working client produces and far shorter than the
    # multi-hour transfer it is protecting.
    zip_stream_idle_seconds: int = 120
    zip_stream_stall_seconds: int = 900

    # ── §233 — metering POST /auth/login ────────────────────────────────
    #
    # Two buckets, because neither one alone is right here. See
    # middleware/rate_limit.login_rate_limit for the full argument; the
    # short version is that the IP this API sees arrives through a
    # Cloudflare tunnel and a reverse proxy, so it is either the same for
    # everybody (one user's failures lock out the instance) or chosen by
    # the caller (no limit at all) — and the process cannot tell which.
    #
    # The ACCOUNT bucket is the real limit: the normalised email from the
    # request body, hashed, 10 attempts per 10 minutes. Unspoofable, and
    # one account being attacked costs no other account its allowance.
    # Counts successes too; a person does not sign in ten times in ten
    # minutes, and counting failures only would let a correct password keep
    # topping the budget up.
    login_rate_limit_per_email: int = 10
    login_rate_limit_email_window_seconds: int = 600

    # The IP bucket is a coarse brake and is deliberately generous: a shared
    # NAT, an office, or the tunnel's own address must not lock real users
    # out. Raise it rather than lower it if legitimate traffic ever trips
    # it. Override with LOGIN_RATE_LIMIT_PER_IP /
    # LOGIN_RATE_LIMIT_IP_WINDOW_SECONDS.
    login_rate_limit_per_ip: int = 60
    login_rate_limit_ip_window_seconds: int = 600

    # ── §234 — metering POST /share/{token}/comment ─────────────────────
    #
    # The one anonymous write path in this API, so the same two buckets as
    # the login above and for the same reasons; see
    # middleware/rate_limit.share_comment_rate_limit.
    #
    # The SHARE TOKEN bucket is the real limit: unspoofable (a caller can
    # only move bucket by holding another link), and one link being flooded
    # costs no other link its allowance. 30 comments per 10 minutes is well
    # above any human reviewer. Override with
    # SHARE_COMMENT_RATE_LIMIT_PER_TOKEN /
    # SHARE_COMMENT_RATE_LIMIT_TOKEN_WINDOW_SECONDS.
    share_comment_rate_limit_per_token: int = 30
    share_comment_rate_limit_token_window_seconds: int = 600

    # The IP bucket is coarse and generous on purpose: the address this API
    # sees comes through a Cloudflare tunnel and a reverse proxy (see
    # middleware/rate_limit.client_ip), so a whole agency reviewing one cut
    # can share it. Raise it rather than lower it if real traffic trips it.
    share_comment_rate_limit_per_ip: int = 120
    share_comment_rate_limit_ip_window_seconds: int = 600

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

    # §221 -- how long the presigned input URL handed to ffmpeg stays valid.
    #
    # It was 7200, hardcoded in the transcoder, and 7200 is shorter than the
    # work one URL has to survive: ONE transcode() signs the input once and
    # then uses it for the ffprobe pass, the HLS ladder (whose own ceiling
    # is 14400 -- twice the old expiry by itself), and, after the ladder has
    # also been uploaded, the thumbnail. Two 95+ GiB masters encoded for
    # ~2 h, uploaded for ~21 min and then failed on the thumbnail with
    # ffmpeg exit 8 against Expires=<start+7200>, discarding a ladder that
    # was finished and correct. The ladder had cleared its own expiry by
    # roughly forty seconds, so a slightly slower file would have died
    # mid-encode instead.
    #
    # 43200 (12 h) is derived from the ceilings in the code, not picked
    # round: 14400 (ladder) + 120 (ffprobe) + up to 2x600 (thumbnail
    # attempts) is ~15720s of BOUNDED work, and the two phases with no
    # timeout at all -- the full-size EXIF download and the multi-GB ladder
    # upload -- get the remaining ~7.6 h. It deliberately equals
    # celery_visibility_timeout_seconds above: that one says a task may run
    # for 12 h, and this one says its input stays readable that long. The
    # hard cap is SigV4's own 604800 (7 days).
    #
    # Override with TRANSCODE_URL_EXPIRY_SECONDS.
    transcode_url_expiry_seconds: int = 43200

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
