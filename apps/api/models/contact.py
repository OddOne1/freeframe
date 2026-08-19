"""Contact-form submissions from inside the authenticated app.

Shaped after ShareLinkActivity (models/share.py) rather than inventing a
different one: a plain timestamped event table with a descending created_at
index, because the only query it exists to answer is "how many in the last
30 days".

The sender's email is stored alongside the FK, and the FK is SET NULL --
same reasoning as ShareLinkActivity's actor_email. A submission is a record
of something that happened; hard-deleting the account later should not
silently rewrite the count or leave a row pointing at nothing.

`target_email` is likewise a snapshot, not a lookup: the configured address
can change, and a row must keep saying where it actually went.
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import String, Text, DateTime, ForeignKey, Index, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

try:
    from ..database import Base
except ImportError:
    from database import Base


class ContactRequest(Base):
    __tablename__ = "contact_requests"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sender_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    sender_email: Mapped[str] = mapped_column(String(255), nullable=False)
    sender_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    subject: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    target_email: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_contact_requests_created", created_at.desc()),
    )
