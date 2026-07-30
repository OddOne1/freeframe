FROM python:3.11-slim

WORKDIR /workspace

RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    curl \
    # EXIF-class metadata (packages/transcoder/base.py::parse_exiftool_metadata).
    # Unlike ffprobe it cannot read a presigned URL, so the transcoder now
    # downloads the source into its existing work dir to run this.
    libimage-exiftool-perl \
    && rm -rf /var/lib/apt/lists/*

# Install API dependencies
COPY apps/api/requirements.txt /workspace/apps/api/requirements.txt
RUN pip install --no-cache-dir -r /workspace/apps/api/requirements.txt

# Copy transcoder package and API
COPY packages/transcoder /workspace/packages/transcoder
COPY apps/api /workspace/apps/api

# Stay in /workspace so imports work as packages
WORKDIR /workspace

CMD ["uvicorn", "apps.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
