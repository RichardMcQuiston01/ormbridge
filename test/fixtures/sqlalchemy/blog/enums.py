import enum


class PostStatus(str, enum.Enum):
    DRAFT = "draft"
    PUBLISHED = "published"
