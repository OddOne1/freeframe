from typing import Optional
from pydantic import BaseModel


class SiteSettingsResponse(BaseModel):
    org_name: str
    logo_dark_url: Optional[str] = None
    logo_light_url: Optional[str] = None

    model_config = {"from_attributes": True}


class SiteSettingsUpdate(BaseModel):
    org_name: Optional[str] = None
    logo_dark_s3_key: Optional[str] = None
    logo_light_s3_key: Optional[str] = None


class SiteLogoUploadResponse(BaseModel):
    upload_url: str
    key: str
