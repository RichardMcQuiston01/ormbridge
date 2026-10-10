from typing import TYPE_CHECKING, Optional

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import TimeStampedModel

if TYPE_CHECKING:
    from .post import Post


class Category(TimeStampedModel):
    __tablename__ = "blog_category"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    slug: Mapped[str] = mapped_column(String(50))
    parent_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("blog_category.id", ondelete="SET NULL")
    )

    parent: Mapped[Optional["Category"]] = relationship(
        back_populates="children", remote_side=[id]
    )
    children: Mapped[list["Category"]] = relationship(back_populates="parent")
    posts: Mapped[list["Post"]] = relationship(back_populates="category")
