import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Category(TimeStampedModel):
    name = models.CharField(max_length=100, unique=True)
    slug = models.SlugField()
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="children"
    )

    class Meta:
        db_table = "blog_category"


class Post(TimeStampedModel):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        PUBLISHED = "published", "Published"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True)
    title = models.CharField(max_length=200, db_index=True)
    body = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    rating = models.DecimalField(max_digits=4, decimal_places=2, null=True)
    view_count = models.PositiveIntegerField(default=0)
    is_featured = models.BooleanField(default=False)
    published_at = models.DateTimeField(default=timezone.now)
    metadata = models.JSONField(default=dict)
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="posts"
    )
    editor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        on_delete=models.SET_NULL,
        related_name="edited_posts",
    )
    category = models.ForeignKey(Category, on_delete=models.PROTECT)
    tags = models.ManyToManyField("Tag", related_name="posts", blank=True)

    class Meta:
        unique_together = [("author", "title")]
        indexes = [models.Index(fields=["published_at", "status"], name="post_pub_status_idx")]


class Tag(models.Model):
    label = models.CharField(max_length=50)


class Profile(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    bio = models.TextField(null=True)
    avatar = models.ImageField(null=True)
