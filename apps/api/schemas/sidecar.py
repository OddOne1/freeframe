import uuid
from datetime import datetime

from pydantic import BaseModel

from ..models.sidecar import SidecarType


class SidecarResponse(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    sidecar_type: SidecarType
    original_filename: str
    # Shape varies by type: CDL gives {"color_corrections": [...]}, ALE gives
    # heading/columns/clips, camera XML gives a flat dotted-path dict.
    parsed_metadata: dict = {}
    created_at: datetime

    model_config = {"from_attributes": True}
