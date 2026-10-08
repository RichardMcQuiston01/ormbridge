"""Django constructs beyond the canonical blog schema (postgres fields, generated fields, proxies)."""

from django.conf import settings
from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.postgres.fields import (
    ArrayField,
    BigIntegerRangeField,
    DateRangeField,
    DateTimeRangeField,
    DecimalRangeField,
    HStoreField,
    IntegerRangeField,
)
from django.db import models
from django.db.models import F, Value
from django.db.models.functions import Concat, Now


class ItemQuerySet(models.QuerySet):
    def active(self):
        return self.filter(is_active=True)


class ActiveManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(is_active=True)


class Item(models.Model):
    class Kind(models.TextChoices):
        TOOL = "tool", "Tool"
        TOY = "toy", "Toy"

    first_name = models.CharField(max_length=40)
    last_name = models.CharField(max_length=40)
    full_name = models.GeneratedField(
        expression=Concat("first_name", Value(" "), "last_name"),
        output_field=models.CharField(max_length=81),
        db_persist=True,
    )
    quantity = models.IntegerField(default=1)
    total_cents = models.GeneratedField(
        expression=F("quantity") * 100,
        output_field=models.IntegerField(),
        db_persist=False,
    )
    tags = ArrayField(models.CharField(max_length=20), default=list, blank=True)
    grid = ArrayField(ArrayField(models.IntegerField()), null=True)
    kinds = ArrayField(models.CharField(max_length=32, choices=Kind.choices), default=list)
    attributes = HStoreField(default=dict)
    stock_range = IntegerRangeField(null=True)
    big_range = BigIntegerRangeField(null=True)
    price_range = DecimalRangeField(null=True)
    available = DateRangeField(null=True)
    valid_during = DateTimeRangeField(null=True)
    last_ip = models.GenericIPAddressField(null=True)
    legacy_ip = models.GenericIPAddressField(protocol="IPv4", unique=True, null=True)
    shelf_life = models.DurationField(null=True)
    source_path = models.FilePathField(path="/tmp", null=True)
    manual = models.FileField(upload_to="manuals/", null=True)
    photo = models.ImageField(upload_to="photos/", null=True)
    small_count = models.SmallIntegerField(default=0)
    tiny_count = models.PositiveSmallIntegerField(default=0)
    is_active = models.BooleanField(db_default=True)
    stocked_at = models.DateTimeField(db_default=Now())
    priority = models.IntegerField(db_default=Value(5))
    note = models.CharField(max_length=20, db_default="none")

    objects = models.Manager()
    active_items = ActiveManager()
    queryset_items = ItemQuerySet.as_manager()
    mixed_items = models.Manager.from_queryset(ItemQuerySet)()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["first_name", "last_name"],
                condition=models.Q(is_active=True),
                name="item_active_name_uniq",
            ),
        ]


class Counter(models.Model):
    small_id = models.SmallAutoField(primary_key=True)
    label = models.CharField(max_length=20)


class ProxyItem(Item):
    class Meta:
        proxy = True
        ordering = ["first_name"]


class ProxyOfProxy(ProxyItem):
    class Meta:
        proxy = True


class Shipment(models.Model):
    item = models.ForeignKey(ProxyItem, on_delete=models.CASCADE, related_name="shipments")
    other = models.ForeignKey(ProxyOfProxy, on_delete=models.CASCADE, related_name="other_shipments")
    content_type = models.ForeignKey("contenttypes.ContentType", on_delete=models.CASCADE)
    object_id = models.PositiveIntegerField()
    target = GenericForeignKey("content_type", "object_id")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)


class Account(models.Model):
    email = models.EmailField(unique=True)

    class Meta:
        swappable = "AUTH_USER_MODEL"


class Assignment(models.Model):
    pk = models.CompositePrimaryKey("item", "account")
    item = models.ForeignKey(Item, on_delete=models.CASCADE)
    account = models.ForeignKey(Account, on_delete=models.CASCADE)
