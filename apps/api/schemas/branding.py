import re
from typing import Optional, Literal
from uuid import UUID
from pydantic import BaseModel, field_validator, model_validator


HEX_COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{6}$')


def _validate_hex_color(v: Optional[str]) -> Optional[str]:
    if v is not None and not HEX_COLOR_RE.match(v):
        raise ValueError("Color must be a 6-digit hex value like '#FF5733'")
    return v


# ── Branding ──────────────────────────────────────────────────────────────────

class BrandingUpdate(BaseModel):
    #: §235 — validated in routers/branding.py::upsert_branding, not here: the
    #: only legal value is the one key POST .../branding/logo-upload issued
    #: FOR THAT PROJECT, and a body schema does not know which project it is
    #: being PUT to. `None` (or an empty string) clears the logo; anything
    #: else that is not this project's own issued key is a 400.
    logo_s3_key: Optional[str] = None
    primary_color: Optional[str] = None
    secondary_color: Optional[str] = None
    custom_title: Optional[str] = None
    custom_footer: Optional[str] = None
    viewer_layout: Optional[Literal["grid", "reel"]] = None
    featured_field: Optional[str] = None

    @field_validator("primary_color", mode="before")
    @classmethod
    def validate_primary_color(cls, v):
        return _validate_hex_color(v)

    @field_validator("secondary_color", mode="before")
    @classmethod
    def validate_secondary_color(cls, v):
        return _validate_hex_color(v)


class BrandingResponse(BaseModel):
    id: UUID
    project_id: UUID
    logo_s3_key: Optional[str] = None
    logo_url: Optional[str] = None        # presigned GET URL, populated at response time
    primary_color: Optional[str] = None
    secondary_color: Optional[str] = None
    custom_title: Optional[str] = None
    custom_footer: Optional[str] = None
    viewer_layout: Optional[str] = None
    featured_field: Optional[str] = None

    model_config = {"from_attributes": True}


class BrandingLogoUploadResponse(BaseModel):
    upload_url: str
    key: str


# ── Watermark ─────────────────────────────────────────────────────────────────

class WatermarkUpdate(BaseModel):
    enabled: Optional[bool] = None
    position: Optional[Literal["center", "corner", "tiled"]] = None
    content: Optional[Literal["email", "name", "custom_text"]] = None
    custom_text: Optional[str] = None
    opacity: Optional[float] = None

    @field_validator("opacity", mode="before")
    @classmethod
    def validate_opacity(cls, v):
        if v is not None and not (0.0 <= v <= 1.0):
            raise ValueError("opacity must be between 0.0 and 1.0")
        return v


class WatermarkResponse(BaseModel):
    id: UUID
    project_id: UUID
    enabled: bool
    position: str
    content: str
    custom_text: Optional[str] = None
    opacity: float

    model_config = {"from_attributes": True}


class WatermarkImageUploadResponse(BaseModel):
    upload_url: str
    key: str
