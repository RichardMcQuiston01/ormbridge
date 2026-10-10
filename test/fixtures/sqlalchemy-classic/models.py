import enum
import uuid

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Table,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class PostStatus(str, enum.Enum):
    DRAFT = "draft"
    PUBLISHED = "published"


class TimeStampedModel(Base):
    __abstract__ = True

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


post_tags = Table(
    "blog_post_tags",
    Base.metadata,
    Column("post_id", Integer, ForeignKey("blog_post.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("blog_tag.id", ondelete="CASCADE"), primary_key=True),
)


class User(Base):
    __tablename__ = "auth_user"

    id = Column(Integer, primary_key=True)

    posts = relationship("Post", back_populates="author", foreign_keys="Post.author_id")
    edited_posts = relationship("Post", back_populates="editor", foreign_keys="Post.editor_id")
    profile = relationship("Profile", back_populates="user", uselist=False)


class Category(TimeStampedModel):
    __tablename__ = "blog_category"

    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False, unique=True)
    slug = Column(String(50), nullable=False)
    parent_id = Column(Integer, ForeignKey("blog_category.id", ondelete="SET NULL"))

    parent = relationship("Category", remote_side=[id], back_populates="children")
    children = relationship("Category", back_populates="parent")
    posts = relationship("Post", back_populates="category")


class Post(TimeStampedModel):
    __tablename__ = "blog_post"
    __table_args__ = (
        UniqueConstraint("author_id", "title"),
        Index("post_pub_status_idx", "published_at", "status"),
    )

    id = Column(Integer, primary_key=True)
    public_id = Column(UUID(as_uuid=True), nullable=False, unique=True, default=uuid.uuid4)
    title = Column(String(200), nullable=False, index=True)
    body = Column(Text, nullable=False)
    status = Column(
        Enum(PostStatus, values_callable=lambda members: [m.value for m in members]),
        nullable=False,
        default=PostStatus.DRAFT,
    )
    rating = Column(Numeric(4, 2))
    view_count = Column(Integer, nullable=False, default=0)
    is_featured = Column(Boolean, nullable=False, default=False)
    published_at = Column(DateTime(timezone=True), nullable=False, default=func.now())
    metadata_ = Column("metadata", JSON, nullable=False, default=dict)
    author_id = Column(Integer, ForeignKey("auth_user.id", ondelete="CASCADE"), nullable=False)
    editor_id = Column(Integer, ForeignKey("auth_user.id", ondelete="SET NULL"))
    category_id = Column(Integer, ForeignKey("blog_category.id", ondelete="RESTRICT"), nullable=False)

    author = relationship("User", back_populates="posts", foreign_keys=[author_id])
    editor = relationship("User", back_populates="edited_posts", foreign_keys=[editor_id])
    category = relationship("Category", back_populates="posts")
    tags = relationship("Tag", secondary=post_tags, backref="posts")


class Tag(Base):
    __tablename__ = "blog_tag"

    id = Column(Integer, primary_key=True)
    label = Column(String(50), nullable=False)


class Profile(Base):
    __tablename__ = "blog_profile"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("auth_user.id", ondelete="CASCADE"), nullable=False, unique=True)
    bio = Column(Text)
    avatar = Column(String(100))

    user = relationship("User", back_populates="profile")
