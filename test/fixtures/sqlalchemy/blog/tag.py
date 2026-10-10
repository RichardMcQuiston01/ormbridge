from typing import TYPE_CHECKING

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base

if TYPE_CHECKING:
    from .post import Post


class Tag(Base):
    __tablename__ = "blog_tag"

    id: Mapped[int] = mapped_column(primary_key=True)
    label: Mapped[str] = mapped_column(String(50))

    posts: Mapped[list["Post"]] = relationship(
        secondary="blog_post_tags", back_populates="tags"
    )
