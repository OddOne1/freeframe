import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class LutResponse(BaseModel):
    id: uuid.UUID
    name: str
    lut_size: Optional[int] = None
    created_at: datetime
    # True when the requesting user uploaded it. The picker uses this to
    # separate "My LUTs" from "Shared with this project", and the settings
    # page uses it to decide whether delete/share are offered at all.
    is_owner: bool = False
    owner_name: Optional[str] = None
    # Token-authenticated proxy URL for the .cube bytes. The browser parses
    # the file itself -- the server never needs to.
    file_url: Optional[str] = None
    # Only populated by GET /projects/{id}/luts: whether this LUT is already
    # shared into that project (owned-but-unshared LUTs are listed too, since
    # the owner can still preview them locally).
    shared_with_project: Optional[bool] = None

    model_config = {"from_attributes": True}


class LutExportResponse(BaseModel):
    """Returned by the graded-download trigger. The file itself arrives
    later via the lut_export_ready SSE event -- this is only an ack."""
    export_id: uuid.UUID
    asset_id: uuid.UUID
    version_id: uuid.UUID
    lut_id: uuid.UUID


class ApplyLutRequest(BaseModel):
    """null clears the asset's grade."""
    lut_id: Optional[uuid.UUID] = None
