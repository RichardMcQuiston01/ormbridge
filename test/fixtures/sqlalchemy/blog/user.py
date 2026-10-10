from typing import TYPE_CHECKING, Optional

from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base

if TYPE_CHECKING:
    from .post import Post
    from .profile import Profile


class User(Base):
    __tablename__ = "auth_user"

    id: Mapped[int] = mapped_column(primary_key=True)

    posts: Mapped[list["Post"]] = relationship(
        back_populates="author", foreign_keys="Post.author_id"
    )
    edited_posts: Mapped[list["Post"]] = relationship(
        back_populates="editor", foreign_keys="Post.editor_id"
    )
    profile: Mapped[Optional["Profile"]] = relationship(
        back_populates="user", uselist=False
    )
