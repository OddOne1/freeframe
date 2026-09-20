# Production Deployment Guide

This guide covers deploying FreeFrame to a production server using Docker Compose.

---

## Hardware Requirements

| | Minimum | Recommended | Heavy Workload |
|---|---|---|---|
| **CPU** | 2 cores | 4 cores | 8+ cores |
| **RAM** | 4 GB | 8 GB | 16+ GB |
| **Storage** | 20 GB SSD | 50 GB SSD | 100+ GB NVMe |
| **Bandwidth** | 100 Mbps | 500 Mbps | 1 Gbps |

- **Minimum** — Small teams (up to 10 users), light video transcoding
- **Recommended** — Medium teams (10-50 users), regular video uploads
- **Heavy Workload** — Large teams (50+ users), frequent 4K video processing

> **Note:** Video transcoding is the most resource-intensive operation. Storage needs depend on your media volume — the actual media files are stored in S3, not on the server.

---

## Deployment Options

FreeFrame runs anywhere Docker is available. Here are common hosting options:

### VPS / Cloud VM (Simplest)

Best for most teams. A single server running Docker Compose.

| Provider | Recommended Plan | Est. Cost/mo |
|----------|-----------------|--------------|
| **Hetzner** | CPX31 (4 vCPU, 8 GB) | ~$15 |
| **DigitalOcean** | Droplet (4 vCPU, 8 GB) | ~$48 |
| **AWS EC2** | t3.medium (4 vCPU, 8 GB) | ~$60 |
| **Google Cloud** | e2-custom (4 vCPU, 8 GB) | ~$75 |
| **Azure** | B4s (4 vCPU, 8 GB) | ~$70 |
| **Hostinger VPS** | KVM 4 (4 vCPU, 16 GB) | ~$16 |

**Setup:** SSH into your server, install Docker, clone the repo, and follow the [Quick Setup](#quick-setup) below.

### Cloud with Managed Services

For teams that want managed databases and less maintenance. Use external PostgreSQL, Redis, and S3 instead of the Docker-included ones. See [Bring Your Own Infrastructure](#bring-your-own-infrastructure).

| Component | AWS | GCP | Azure |
|-----------|-----|-----|-------|
| Server | EC2 / ECS | Compute Engine / Cloud Run | VM / Container Apps |
| Database | RDS PostgreSQL | Cloud SQL | Azure Database for PostgreSQL |
| Redis | ElastiCache | Memorystore | Azure Cache for Redis |
| Storage | S3 | Cloud Storage | Blob Storage (via S3 API) |
| Email | SES | (use SMTP) | (use SMTP) |

### Bare Metal / On-Premise

FreeFrame is fully self-contained. Install Docker on any Linux server (Ubuntu 22.04+ recommended) and follow the Quick Setup. Ideal for organizations that require media to stay on their own hardware.

---

## Prerequisites

- A server meeting the [hardware requirements](#hardware-requirements) with **Docker** and **Docker Compose** installed
- A **domain name** pointed to your server's IP (for SSL — optional for testing)
- An **S3-compatible storage** bucket (AWS S3, Cloudflare R2, Backblaze B2, etc.)
- An **SMTP server** or AWS SES for sending emails

## Quick Setup

```bash
# 1. Clone the repository
git clone https://github.com/Techiebutler/freeframe.git
cd freeframe

# 2. Create your production environment file
cp .env.example .env.prod

# 3. Edit .env.prod with your actual credentials
#    At minimum: change passwords, configure S3, email, and JWT_SECRET
nano .env.prod

# 4. Build and start all services
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build

# 5. Check that everything is running
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

FreeFrame is now running on **port 80**. The first user to sign up becomes the super admin via the setup wizard.

---

## SSL / TLS Setup

FreeFrame uses **Traefik** as its reverse proxy, which can automatically provision and renew **Let's Encrypt** SSL certificates with zero manual setup.

### Enabling SSL

Set these two variables in your `.env.prod`:

```
DOMAIN=your-domain.com
ACME_EMAIL=admin@your-domain.com
FRONTEND_URL=https://your-domain.com
```

Then start (or restart) the services:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

That's it. Traefik will:
- Automatically obtain SSL certificates from Let's Encrypt
- Serve your site over HTTPS on port 443
- Auto-renew certificates before they expire

> **Requirements:** Your domain's DNS A record must point to your server, and ports 80 + 443 must be open. Traefik needs port 80 for the ACME HTTP challenge even when serving HTTPS.

### Without SSL (HTTP only)

If you don't set `DOMAIN` and `ACME_EMAIL`, FreeFrame runs on **HTTP port 80** only. This is fine for:
- Local testing of the production build
- Running behind an external reverse proxy that handles SSL

### Behind an External Reverse Proxy (Cloudflare, Caddy, etc.)

If FreeFrame sits behind another proxy that already handles SSL:

1. Don't set `DOMAIN` / `ACME_EMAIL` — let Traefik run in HTTP mode
2. Point your external proxy to FreeFrame's port 80
3. Ensure the proxy forwards these headers: `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`
4. For **Cloudflare**: set SSL mode to "Full"
5. Set `FRONTEND_URL` in `.env.prod` to your `https://` URL

---

## Bring Your Own Infrastructure

FreeFrame's Docker Compose includes PostgreSQL and Redis by default, but you can use external managed services instead.

### External Database (PostgreSQL)

Works with: **AWS RDS, Google Cloud SQL, Supabase, Neon, DigitalOcean Managed DB, or any PostgreSQL 15+ instance.**

1. Remove the `postgres` service and `pgdata` volume from `docker-compose.prod.yml`
2. Remove `postgres` from the `depends_on` of the `api` and `worker` services
3. In `.env.prod`, set `DATABASE_URL` to your external database:
   ```
   DATABASE_URL=postgresql://user:password@your-db-host:5432/freeframe
   ```
4. Run migrations once manually on first deploy:
   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm api sh -c "cd /workspace/apps/api && alembic upgrade head"
   ```

### External Redis / Valkey

Works with: **AWS ElastiCache, Upstash, Redis Cloud, DigitalOcean Managed Redis, or any Redis 7+ / Valkey instance.** Valkey is a drop-in Redis replacement and works out of the box.

1. Remove the `redis` service and `redisdata` volume from `docker-compose.prod.yml`
2. Remove `redis` from the `depends_on` of the `api`, `worker`, `email_worker`, and `beat` services
3. In `.env.prod`, set `REDIS_URL` to your external instance:
   ```
   REDIS_URL=redis://:password@your-redis-host:6379/0
   ```

### External S3 Storage

Works with: **AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO, or any S3-compatible service.**

There's no S3 service in the production compose — you always provide your own. Configure in `.env.prod`:

```
S3_STORAGE=s3
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY=YOUR_ACCESS_KEY
S3_SECRET_KEY=YOUR_SECRET_KEY
S3_REGION=us-east-1
```

For **non-AWS providers**, also set the endpoint:

| Provider | S3_ENDPOINT |
|----------|-------------|
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` |
| MinIO (self-hosted) | `http://your-minio-host:9000` |

Make sure your bucket has CORS configured to allow requests from your FreeFrame domain.

### External SMTP

Works with: **Mailgun, Postmark, SendGrid, Amazon SES, or any SMTP server.**

Configure in `.env.prod`:

**SMTP (most providers):**
```
MAIL_PROVIDER=smtp
MAIL_FROM_ADDRESS=noreply@your-domain.com
MAIL_FROM_NAME=FreeFrame
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_USE_TLS=true
```

**AWS SES:**
```
MAIL_PROVIDER=ses
MAIL_FROM_ADDRESS=noreply@your-domain.com
MAIL_FROM_NAME=FreeFrame
AWS_MAIL_ACCESS_KEY_ID=YOUR_KEY
AWS_MAIL_SECRET_ACCESS_KEY=YOUR_SECRET
AWS_MAIL_REGION=us-east-1
```

---

## Configuration Reference

All environment variables are documented in [`.env.example`](../.env.example). Key settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | (required) |
| `REDIS_URL` | Redis connection string | (required) |
| `S3_STORAGE` | `s3` for any S3-compatible provider | `minio` |
| `S3_BUCKET` | S3 bucket name | (required) |
| `S3_ENDPOINT` | Custom S3 endpoint (non-AWS) | (empty = AWS) |
| `JWT_SECRET` | Auth token signing key | (required, generate with `openssl rand -hex 64`) |
| `FRONTEND_URL` | Your FreeFrame URL (with https://) | (required) |
| `DOMAIN` | Your domain for auto SSL | (optional) |
| `ACME_EMAIL` | Email for Let's Encrypt notifications | (optional) |
| `MAIL_PROVIDER` | `smtp` or `ses` | `smtp` |
| `API_WORKERS` | Gunicorn worker processes | `4` |
| `TRANSCODING_CONCURRENCY` | Parallel transcoding jobs | `2` |
| `EMAIL_CONCURRENCY` | Parallel email jobs | `2` |

---

## Scaling

### API Workers

The `API_WORKERS` env var controls how many gunicorn worker processes handle API requests. A good starting point:

```
API_WORKERS = (2 x CPU cores) + 1
```

### Transcoding Workers

Video transcoding is CPU-intensive. Adjust `TRANSCODING_CONCURRENCY` based on your server:

| Server | Recommended |
|--------|-------------|
| 2 cores | 1-2 |
| 4 cores | 2-3 |
| 8+ cores | 4-6 |

### Email Workers

Email sending is I/O-bound and lightweight. The default of `2` is sufficient for most deployments.

---

## Monitoring

### Health Check

The API exposes a health endpoint:

```
GET /health → { "status": "ok" }
```

Use this for uptime monitoring (UptimeRobot, Healthchecks.io, etc.) or Docker health checks.

### Logs

```bash
# Follow all service logs
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f

# Follow a specific service
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f api

# Last 100 lines
docker compose --env-file .env.prod -f docker-compose.prod.yml logs --tail 100 api
```

### Key Metrics to Watch

| Metric | How to Check | Warning Sign |
|--------|-------------|--------------|
| Disk space | `df -h` | > 80% used |
| Memory | `free -m` | Swap in use |
| API response | `curl -s localhost/health` | Non-200 response |
| Worker queue | `docker compose exec api celery -A tasks.celery_app inspect active` | Growing backlog |
| Database connections | `docker compose exec postgres psql -U freeframe -c "SELECT count(*) FROM pg_stat_activity;"` | > 80% of max |

---

## Account security

Every account needs two things before it can use the app: a password, and a
**separate** address for password resets. Both are checked server-side on
every request, so a user who has neither sees a blocking setup screen instead
of the dashboard.

### Why the two addresses

Reset codes go **only** to the backup address; two-factor sign-in codes go
**only** to the login address, and neither falls back to the other. That
separation is the whole point: while one mailbox could both receive the
sign-in code and reset the password, that mailbox *was* the account, and the
second factor added nothing.

A backup address on the same domain as the login address is accepted, but the
setup screen warns about it — one administrator with domain-wide access can
read both mailboxes, which defeats the split.

### Passwords

Enforced by `apps/api/services/password_policy.py`, on every path that sets a
password (setup, invite, reset, change):

- at least 12 characters;
- at least one upper-case letter, one lower-case letter, one digit and one
  special character — **at every length, including long passphrases**;
- not in `apps/api/data/common_passwords.txt` (the ~10k most common);
- must not contain the local part of either address, the user's name, or the
  instance name;
- a zxcvbn strength score of at least 3 of 4, so `Sommer2026!` is refused
  although it satisfies all four character classes.

There is no forced rotation and no expiry, deliberately: both push people
towards `Sommer2026!` and then `Herbst2026!`, which the strength rule is there
to catch.

### The passwordless cut-off

Accounts that never had a password can still sign in with a magic code, and
are sent to the setup screen when they do. That route closes on the date in
`site_settings.password_required_after`, which the migration sets to **30 days
after it runs on this instance**. To move it:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  psql -U freeframe freeframe \
  -c "UPDATE site_settings SET password_required_after = now() + interval '60 days';"
```

`NULL` means the route never closes.

### Unblocking a locked-out account

A gate on an undeliverable address is a lockout, so there are two ways out.

**From the app**, a superadmin uses **Clear Setup Block** on the user's row in
Settings → Admin. It waives the block, not the requirement: the user is still
asked to finish in Settings → Profile, and confirming a backup address clears
the waiver again. It is recorded in the activity log.

**From the shell**, for the case where the stuck account *is* the last
superadmin and there is nobody to press that button:

```bash
# Dry run — reports what is outstanding and changes nothing
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api \
  python -m apps.api.scripts.clear_account_gate someone@example.com

# Apply it
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api \
  python -m apps.api.scripts.clear_account_gate someone@example.com --write
```

The script never sets a password and never invents a backup address — both
would put a credential chosen by whoever holds a shell into the database,
which is exactly the authority this design keeps out of one person's hands.

### Keep two superadmins

Both escape hatches above need *somebody else*: the admin one refuses to act
on your own 2FA, and with a single superadmin there is no in-app way back if
that account is the one that gets stuck. Settings → Admin shows a dismissible
banner while only one exists. Making a second person an administrator is the
fix; the shell script is the fallback, and it needs SSH access to this host.

---

## Backups

### Database Backup

```bash
# One-time backup
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  pg_dump -U freeframe freeframe | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz

# Restore from backup
gunzip -c backup_20260403_120000.sql.gz | \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U freeframe freeframe
```

### Automated Daily Backups

Add a cron job on your server:

```bash
# Edit crontab
crontab -e

# Add this line (runs daily at 2 AM, keeps 30 days)
0 2 * * * cd /path/to/freeframe && docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres pg_dump -U freeframe freeframe | gzip > /path/to/backups/freeframe_$(date +\%Y\%m\%d).sql.gz && find /path/to/backups -name "freeframe_*.sql.gz" -mtime +30 -delete
```

### S3 Media Backup

Your media files are already in S3. For redundancy:

- **AWS S3**: Enable [versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) and [cross-region replication](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html)
- **Cloudflare R2**: Use [Sippy](https://developers.cloudflare.com/r2/data-migration/sippy/) for incremental migration/backup
- **Self-hosted MinIO**: Use [`mc mirror`](https://min.io/docs/minio/linux/reference/minio-mc/mc-mirror.html) to replicate to a second location

### What to Back Up

| Data | Location | Priority |
|------|----------|----------|
| Database | PostgreSQL | **Critical** — all users, projects, comments, share links |
| Media files | S3 bucket | **Important** — uploaded assets and transcoded files |
| Environment config | `.env.prod` | **Important** — save a copy outside the server |
| SSL certificates | `letsencrypt/` volume | Low — Traefik auto-renews them |

---

## Updating

```bash
cd freeframe
git pull origin main
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Database migrations run automatically on API startup. Always check the [CHANGELOG](../CHANGELOG.md) before updating.

### Update Checklist

1. **Read the changelog** — check for breaking changes or new env vars
2. **Backup the database** — `pg_dump` before updating (see [Backups](#backups))
3. **Pull and rebuild** — `git pull && docker compose up -d --build`
4. **Verify** — check `/health`, test login, spot-check a share link
5. **Rollback if needed** — `git checkout v1.x.x && docker compose up -d --build`

---

## Troubleshooting

### Services not starting

```bash
# Check logs for a specific service
docker compose --env-file .env.prod -f docker-compose.prod.yml logs api
docker compose --env-file .env.prod -f docker-compose.prod.yml logs worker
docker compose --env-file .env.prod -f docker-compose.prod.yml logs web
docker compose --env-file .env.prod -f docker-compose.prod.yml logs traefik

# Check all service statuses
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

### Database migration failures

```bash
# Run migrations manually
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm api sh -c "cd /workspace/apps/api && alembic upgrade head"

# Check migration status
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm api sh -c "cd /workspace/apps/api && alembic current"
```

### SSL certificate not working

- Verify `DOMAIN` and `ACME_EMAIL` are set in `.env.prod`
- Check that DNS A record points to your server: `dig your-domain.com`
- Ensure ports 80 and 443 are open: `sudo ufw allow 80,443/tcp`
- Check Traefik logs: `docker compose --env-file .env.prod -f docker-compose.prod.yml logs traefik`
- Let's Encrypt has rate limits — if you hit them, wait an hour and retry

### S3 connection issues

- Verify your credentials are correct in `.env.prod`
- Ensure your bucket exists and has proper CORS configuration
- For non-AWS providers, double-check the `S3_ENDPOINT` URL

### Port 80/443 already in use

```bash
# Find what's using the port
sudo lsof -i :80
# Stop that service or change the port mapping in docker-compose.prod.yml
```

### Large file uploads failing

Large media files are uploaded directly to S3 via presigned URLs (bypassing Traefik), so proxy limits don't apply to file data. If uploads still fail:
- Check that your S3 bucket doesn't have a size limit
- Verify your server has enough `/tmp` space for transcoding
- Check worker logs for processing errors
