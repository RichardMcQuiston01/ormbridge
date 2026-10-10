import enum
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional

from sqlalchemy import JSON, Column, DateTime, Enum, Index, Text, UniqueConstraint, func
from sqlmodel import Field, Relationship, SQLModel


class PostStatus(str, enum.Enum):
    DRAFT = "draft"
    PUBLISHED = "published"


class TimeStampedModel(SQLModel):
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_type=DateTime(timezone=True),
        sa_column_kwargs={"server_default": func.now()},
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_type=DateTime(timezone=True),
        sa_column_kwargs={"server_default": func.now(), "onupdate": func.now()},
    )


class PostTag(SQLModel, table=True):
    __tablename__ = "blog_post_tags"

    post_id: Optional[int] = Field(
        default=None, foreign_key="blog_post.id", primary_key=True, ondelete="CASCADE"
    )
    tag_id: Optional[int] = Field(
        default=None, foreign_key="blog_tag.id", primary_key=True, ondelete="CASCADE"
    )


class User(SQLModel, table=True):
    __tablename__ = "auth_user"

    id: Optional[int] = Field(default=None, primary_key=True)

    posts: List["Post"] = Relationship(
        back_populates="author",
        sa_relationship_kwargs={"foreign_keys": "[Post.author_id]"},
    )
    edited_posts: List["Post"] = Relationship(
        back_populates="editor",
        sa_relationship_kwargs={"foreign_keys": "[Post.editor_id]"},
    )
    profile: Optional["Profile"] = Relationship(
        back_populates="user", sa_relationship_kwargs={"uselist": False}
    )


class Category(TimeStampedModel, table=True):
    __tablename__ = "blog_category"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(max_length=100, unique=True)
    slug: str = Field(max_length=50)
    parent_id: Optional[int] = Field(
        default=None, foreign_key="blog_category.id", ondelete="SET NULL"
    )

    parent: Optional["Category"] = Relationship(
        back_populates="children",
        sa_relationship_kwargs={"remote_side": "Category.id"},
    )
    children: List["Category"] = Relationship(back_populates="parent")
    posts: List["Post"] = Relationship(back_populates="category")


class Post(TimeStampedModel, table=True):
    __tablename__ = "blog_post"
    __table_args__ = (
        UniqueConstraint("author_id", "title"),
        Index("post_pub_status_idx", "published_at", "status"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    public_id: uuid.UUID = Field(default_factory=uuid.uuid4, unique=True)
    title: str = Field(max_length=200, index=True)
    body: str = Field(sa_type=Text)
    status: PostStatus = Field(
        default=PostStatus.DRAFT,
        sa_type=Enum(
            PostStatus, values_callable=lambda members: [m.value for m in members]
        ),
    )
    rating: Optional[Decimal] = Field(default=None, max_digits=4, decimal_places=2)
    view_count: int = 0
    is_featured: bool = False
    published_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_type=DateTime(timezone=True),
    )
    metadata_: dict = Field(
        default_factory=dict,
        sa_column=Column("metadata", JSON, nullable=False, default=dict),
    )
    author_id: int = Field(foreign_key="auth_user.id", ondelete="CASCADE")
    editor_id: Optional[int] = Field(
        default=None, foreign_key="auth_user.id", ondelete="SET NULL"
    )
    category_id: int = Field(foreign_key="blog_category.id", ondelete="RESTRICT")

    author: User = Relationship(
        back_populates="posts",
        sa_relationship_kwargs={"foreign_keys": "[Post.author_id]"},
    )
    editor: Optional[User] = Relationship(
        back_populates="edited_posts",
        sa_relationship_kwargs={"foreign_keys": "[Post.editor_id]"},
    )
    category: Category = Relationship(back_populates="posts")
    tags: List["Tag"] = Relationship(back_populates="posts", link_model=PostTag)


class Tag(SQLModel, table=True):
    __tablename__ = "blog_tag"

    id: Optional[int] = Field(default=None, primary_key=True)
    label: str = Field(max_length=50)

    posts: List[Post] = Relationship(back_populates="tags", link_model=PostTag)


class Profile(SQLModel, table=True):
    __tablename__ = "blog_profile"

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="auth_user.id", ondelete="CASCADE", unique=True)
    bio: Optional[str] = Field(default=None, sa_type=Text)
    avatar: Optional[str] = Field(default=None, max_length=100)

    user: User = Relationship(back_populates="profile")
