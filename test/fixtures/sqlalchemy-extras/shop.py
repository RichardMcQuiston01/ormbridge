"""A shop schema that uses the less common SQLAlchemy 2.0 constructs (SQLite-compatible)."""

import datetime as dt
import enum
import uuid
from decimal import Decimal
from typing import Annotated, Any, Literal, Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Computed,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Interval,
    LargeBinary,
    Numeric,
    SmallInteger,
    String,
    Table,
    Text,
    Time,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    MappedAsDataclass,
    backref,
    declared_attr,
    mapped_column,
    relationship,
)

intpk = Annotated[int, mapped_column(primary_key=True)]
str50 = Annotated[str, mapped_column(String(50))]
created_stamp = Annotated[
    dt.datetime, mapped_column(DateTime(timezone=True), server_default=func.now())
]


class Base(DeclarativeBase):
    type_annotation_map = {
        dict[str, Any]: JSON,
        Decimal: Numeric(12, 2),
    }


class Currency(enum.Enum):
    USD = "usd"
    EUR = "eur"


class AuditMixin:
    created_at: Mapped[created_stamp]
    created_by: Mapped[Optional[str50]]


class TableNameMixin:
    @declared_attr.directive
    def __tablename__(cls) -> str:
        return cls.__name__.lower()


follows = Table(
    "follows",
    Base.metadata,
    Column("follower_id", ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True),
    Column("followed_id", ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True),
)

audit_log = Table(
    "audit_log",
    Base.metadata,
    Column("id", Integer, primary_key=True),
    Column("message", Text, nullable=False),
)


class Customer(AuditMixin, Base):
    __tablename__ = "customers"
    __table_args__ = (
        CheckConstraint("credit >= 0", name="ck_customers_credit"),
        UniqueConstraint("email", "name", name="uq_customers_email_name"),
    )

    id: Mapped[intpk]
    email: Mapped[str] = mapped_column(String(255), unique=True)
    name: Mapped[str50]
    nickname: Mapped[Optional[str]]
    tier: Mapped[Literal["free", "pro"]] = mapped_column(default="free")
    credit: Mapped[Decimal] = mapped_column(default=Decimal("0"))
    prefs: Mapped[dict[str, Any]] = mapped_column(default=dict)
    birthday: Mapped[Optional[dt.date]] = mapped_column(Date)
    wakes_at: Mapped[Optional[dt.time]] = mapped_column(Time)
    lifetime: Mapped[Optional[dt.timedelta]] = mapped_column(Interval)
    avatar: Mapped[Optional[bytes]] = mapped_column(LargeBinary)
    score: Mapped[float] = mapped_column(Float, server_default=text("0.5"))
    visits: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    rank: Mapped[int] = mapped_column(SmallInteger, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=text("1"))
    external_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid.uuid4)
    referrer_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("customers.id", ondelete="SET NULL", onupdate="CASCADE")
    )

    referrer: Mapped[Optional["Customer"]] = relationship(
        remote_side="Customer.id", back_populates="referrals"
    )
    referrals: Mapped[list["Customer"]] = relationship(back_populates="referrer")
    following: Mapped[list["Customer"]] = relationship(
        secondary=follows,
        primaryjoin=lambda: Customer.id == follows.c.follower_id,
        secondaryjoin=lambda: Customer.id == follows.c.followed_id,
        back_populates="followers",
    )
    followers: Mapped[list["Customer"]] = relationship(
        secondary=follows,
        primaryjoin=lambda: Customer.id == follows.c.followed_id,
        secondaryjoin=lambda: Customer.id == follows.c.follower_id,
        back_populates="following",
    )
    addresses: Mapped[list["Address"]] = relationship(back_populates="customer")


Index("ix_customers_email_lower", func.lower(Customer.email))
Index(
    "ix_customers_active_name",
    Customer.name,
    Customer.is_active,
    sqlite_where=text("is_active = 1"),
)


class Address(Base):
    __tablename__ = "addresses"

    customer_id: Mapped[int] = mapped_column(
        ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(String(20), primary_key=True)
    line1: Mapped[str] = mapped_column(String(120))
    line2: Mapped[Optional[str]] = mapped_column(String(120))

    customer: Mapped["Customer"] = relationship(back_populates="addresses")


class Warehouse(Base):
    __tablename__ = "warehouses"

    region: Mapped[str] = mapped_column(String(10), primary_key=True)
    code: Mapped[str] = mapped_column(String(10), primary_key=True)
    label: Mapped[str] = mapped_column(String(50))


class Invoice(TableNameMixin, Base):
    __table_args__ = (
        ForeignKeyConstraint(
            ["ship_region", "ship_code"],
            ["warehouses.region", "warehouses.code"],
            ondelete="SET NULL",
            name="fk_invoice_ship",
        ),
        Index("ix_invoice_issued", "issued_on", unique=False),
        Index("ix_invoice_number_desc", text("number")),
    )

    id: Mapped[intpk]
    number: Mapped[str] = mapped_column(String(32))
    state: Mapped[str] = mapped_column(
        Enum("new", "paid", "void", name="invoice_state"), default="new"
    )
    currency: Mapped[Currency] = mapped_column(default=Currency.USD)
    issued_on: Mapped[dt.date] = mapped_column(default=dt.date.today)
    subtotal: Mapped[Decimal]
    tax: Mapped[Decimal] = mapped_column(default=0)
    total: Mapped[Decimal] = mapped_column(Computed("subtotal + tax", persisted=True))
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("customers.id", ondelete="RESTRICT", onupdate="CASCADE")
    )
    billing_customer_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("customers.id", ondelete="NO ACTION")
    )
    ship_region: Mapped[Optional[str]] = mapped_column(String(10))
    ship_code: Mapped[Optional[str]] = mapped_column(String(10))

    customer: Mapped["Customer"] = relationship(foreign_keys=[customer_id])
    billing_customer: Mapped[Optional["Customer"]] = relationship(
        foreign_keys=[billing_customer_id]
    )
    items: Mapped[list["LineItem"]] = relationship(back_populates="invoice")


class Product(Base):
    __tablename__ = "products"

    id: Mapped[intpk]
    sku: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(20), default="product")
    name: Mapped[str50]
    stock: Mapped[int] = mapped_column(default=0, nullable=False)

    items: Mapped[list["LineItem"]] = relationship(back_populates="product")


class Book(Product):
    __tablename__ = "books"

    id: Mapped[int] = mapped_column(ForeignKey("products.id"), primary_key=True)
    isbn: Mapped[str] = mapped_column(String(20), unique=True)


class LineItem(Base):
    __tablename__ = "line_items"

    invoice_id: Mapped[int] = mapped_column(
        ForeignKey("invoice.id", ondelete="CASCADE"), primary_key=True
    )
    product_id: Mapped[int] = mapped_column(
        ForeignKey("products.id", ondelete="RESTRICT"), primary_key=True
    )
    quantity: Mapped[int] = mapped_column(default=1)

    invoice: Mapped["Invoice"] = relationship(back_populates="items")
    product: Mapped["Product"] = relationship(back_populates="items")


class Review(Base):
    __tablename__ = "reviews"

    id: Mapped[intpk]
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    body: Mapped[str] = mapped_column(Text)
    posted_at: Mapped[dt.datetime] = mapped_column(
        DateTime, default=lambda: dt.datetime.now(dt.timezone.utc)
    )

    product: Mapped["Product"] = relationship(
        backref=backref("reviews", uselist=True)
    )


class Note(MappedAsDataclass, Base):
    __tablename__ = "notes"

    id: Mapped[intpk] = mapped_column(init=False)
    text_: Mapped[str] = mapped_column("text", Text)
    pinned: Mapped[bool] = mapped_column(default=False)
    author_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("customers.id"), default=None
    )
