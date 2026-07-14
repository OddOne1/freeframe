from typing import Optional, Dict, Any
from pydantic import BaseModel


class SiteSettingsResponse(BaseModel):
    org_name: str
    logo_dark_url: Optional[str] = None
    logo_light_url: Optional[str] = None
    logo_login_url: Optional[str] = None
    favicon_url: Optional[str] = None
    theme_colors: Optional[Dict[str, Any]] = None

    model_config = {"from_attributes": True}


class SiteSettingsUpdate(BaseModel):
    org_name: Optional[str] = None
    logo_dark_s3_key: Optional[str] = None
    logo_light_s3_key: Optional[str] = None
    logo_login_s3_key: Optional[str] = None
    favicon_s3_key: Optional[str] = None
    theme_colors: Optional[Dict[str, Any]] = None


class SiteLogoUploadResponse(BaseModel):
    upload_url: str
    key: str

class SiteFaviconUploadResponse(BaseModel):
    upload_url: str
    key: str
