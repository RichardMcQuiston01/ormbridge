"""PostgreSQL-only constructs. Read by the parser tests; SQLite cannot create these tables."""

import enum
import uuid
from typing import Optional

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    MetaData,
    Sequence,
    String,
    Table,
    Text,
    func,
    text,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import (
    ARRAY,
    HSTORE,
    INET,
    INT4RANGE,
    JSONB,
    TIMESTAMP,
    UUID,
    ExcludeConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class InventoryBase(DeclarativeBase):
    metadata = MetaData(schema="inventory")


class Mood(enum.Enum):
    HAPPY = "happy"
    SAD = "sad"


class Device(InventoryBase):
    __tablename__ = "devices"
    __table_args__ = (
        CheckConstraint("cardinality(tags) < 20", name="ck_devices_tags"),
        Index("ix_devices_tags", "tags", postgresql_using="gin"),
        Index(
            "ix_devices_live",
            "last_seen",
            unique=True,
            postgresql_where=text("retired IS FALSE"),
        ),
        ExcludeConstraint(("window", "&&"), name="ex_devices_window"),
        {"schema": "inventory", "comment": "Hardware"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    serial: Mapped[int] = mapped_column(Integer, Sequence("device_serial_seq"))
    ticket: Mapped[int] = mapped_column(Identity(always=True), unique=True)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(30)), default=list)
    grid: Mapped[list[list[int]]] = mapped_column(ARRAY(Integer, dimensions=2))
    attrs: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb")
    )
    labels: Mapped[Optional[dict]] = mapped_column(HSTORE)
    address: Mapped[Optional[str]] = mapped_column(INET)
    window: Mapped[Optional[str]] = mapped_column(INT4RANGE)
    last_seen: Mapped[Optional[str]] = mapped_column(TIMESTAMP(timezone=True))
    retired: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    mood: Mapped[Mood] = mapped_column(
        postgresql.ENUM(Mood, name="mood", create_type=False), default=Mood.HAPPY
    )
    shape: Mapped[Optional[str]] = mapped_column(Geometry("POINT"))
    owner_id: Mapped[Optional[int]] = mapped_column(ForeignKey("inventory.owners.id"))

    owner: Mapped[Optional["Owner"]] = relationship(back_populates="devices")


class Owner(InventoryBase):
    __tablename__ = "owners"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text)

    devices: Mapped[list["Device"]] = relationship(back_populates="owner")
