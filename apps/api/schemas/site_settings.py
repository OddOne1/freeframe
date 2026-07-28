from typing import Optional, Dict, Any
from pydantic import BaseModel


class SiteSettingsResponse(BaseModel):
    org_name: str
    logo_dark_url: Optional[str] = None
    logo_light_url: Optional[str] = None
    logo_login_url: Optional[str] = None
    favicon_url: Optional[str] = None
    theme_colors: Optional[Dict[str, Any]] = None
    total_storage_limit_bytes: Optional[int] = None
    # Live-computed, not stored -- sum of MediaFile.file_size_bytes across
    # every non-deleted asset platform-wide. Only populated for an
    # authenticated superadmin caller (GET /site-settings is otherwise
    # public/unauthenticated, backing the login page's branding) so real
    # usage figures never leak to anonymous visitors.
    total_storage_used_bytes: Optional[int] = None

    model_config = {"from_attributes": True}


class SiteSettingsUpdate(BaseModel):
    org_name: Optional[str] = None
    logo_dark_s3_key: Optional[str] = None
    logo_light_s3_key: Optional[str] = None
    logo_login_s3_key: Optional[str] = None
    favicon_s3_key: Optional[str] = None
    theme_colors: Optional[Dict[str, Any]] = None
    total_storage_limit_bytes: Optional[int] = None
