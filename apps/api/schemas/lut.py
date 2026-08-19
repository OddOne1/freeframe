import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class LutGroupResponse(BaseModel):
    id: uuid.UUID
    name: str
    #: NULL = a top-level Main group; otherwise the Main group this Sub group
    #: sits under (§45). Exactly one level, enforced server-side.
    parent_group_id: Optional[uuid.UUID] = None
    #: Shared/global rather than one user's. Sent on personal groups too, so
    #: the client never has to infer which endpoint a group came from.
    is_platform: bool = False
    created_at: datetime

    model_config = {"from_attributes": True}


class LutGroupCreate(BaseModel):
    name: str
    #: Creating a Sub group goes through the same endpoint as a Main one,
    #: with a parent named. A separate endpoint would duplicate the name
    #: validation and the platform/personal split for no gain.
    parent_group_id: Optional[uuid.UUID] = None


class LutGroupUpdate(BaseModel):
    name: Optional[str] = None


class LutUpdate(BaseModel):
    """Rename, re-group, or flip platform-wide.

    is_platform_wide is superadmin-only and enforced server-side; the other
    two are owner-only. Optional-everything so a caller can touch one field
    without resending the rest -- model_fields_set distinguishes "not sent"
    from "explicitly null" (needed for clearing group_id).
    """
    name: Optional[str] = None
    group_id: Optional[uuid.UUID] = None
    is_platform_wide: Optional[bool] = None


class LutResponse(BaseModel):
    id: uuid.UUID
    name: str
    lut_size: Optional[int] = None
    created_at: datetime
    # Third visibility tier -- usable everywhere with no share row.
    is_platform_wide: bool = False
    group_id: Optional[uuid.UUID] = None
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
    # Project IDs this LUT is currently shared into. Populated by
    # GET /me/luts so the share popover can render its toggles without one
    # request per project.
    shared_project_ids: list[uuid.UUID] = []

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
