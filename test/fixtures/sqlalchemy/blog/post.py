import uuid
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Optional

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Numeric,
    String,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimeStampedModel
from .enums import PostStatus

if TYPE_CHECKING:
    from .category import Category
    from .tag import Tag
    from .user import User

post_tags = Table(
    "blog_post_tags",
    Base.metadata,
    Column("post_id", ForeignKey("blog_post.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", ForeignKey("blog_tag.id", ondelete="CASCADE"), primary_key=True),
)


class Post(TimeStampedModel):
    __tablename__ = "blog_post"
    __table_args__ = (
        UniqueConstraint("author_id", "title"),
        Index("post_pub_status_idx", "published_at", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(200), index=True)
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[PostStatus] = mapped_column(
        Enum(PostStatus, values_callable=lambda members: [m.value for m in members]),
        default=PostStatus.DRAFT,
    )
    rating: Mapped[Optional[Decimal]] = mapped_column(Numeric(4, 2))
    view_count: Mapped[int] = mapped_column(default=0)
    is_featured: Mapped[bool] = mapped_column(default=False)
    published_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=func.now()
    )
    metadata_: Mapped[dict] = mapped_column("metadata", JSON, default=dict)
    author_id: Mapped[int] = mapped_column(
        ForeignKey("auth_user.id", ondelete="CASCADE")
    )
    editor_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("auth_user.id", ondelete="SET NULL")
    )
    category_id: Mapped[int] = mapped_column(
        ForeignKey("blog_category.id", ondelete="RESTRICT")
    )

    author: Mapped["User"] = relationship(
        back_populates="posts", foreign_keys=[author_id]
    )
    editor: Mapped[Optional["User"]] = relationship(
        back_populates="edited_posts", foreign_keys=[editor_id]
    )
    category: Mapped["Category"] = relationship(back_populates="posts")
    tags: Mapped[list["Tag"]] = relationship(
        secondary=post_tags, back_populates="posts"
    )
