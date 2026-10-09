package shop

import (
	"database/sql"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// Role is stored as a string; its constants become an enum.
type Role string

const (
	RoleCustomer Role = "customer"
	RoleStaff    Role = "staff"
	RoleAdmin    Role = "admin"
)

// Priority has integer constants, which the shared model stores as a plain integer.
type Priority int

const (
	PriorityLow Priority = iota + 1
	PriorityHigh
)

// Address is embedded into other structs, where its columns get a prefix.
type Address struct {
	Street string  `gorm:"size:120"`
	City   string  `gorm:"size:60"`
	Postal *string `gorm:"column:zip;size:12"`
}

// Customer embeds gorm.Model (id, created_at, updated_at, deleted_at).
type Customer struct {
	gorm.Model
	Email    string          `gorm:"size:255;not null;uniqueIndex"`
	Name     sql.NullString  `gorm:"size:100"`
	Role     Role            `gorm:"size:20;not null;default:customer"`
	Billing  Address         `gorm:"embedded;embeddedPrefix:billing_"`
	Shipping Address         `gorm:"embedded;embeddedPrefix:shipping_"`
	Balance  decimal.Decimal `gorm:"type:numeric(12,2);not null;default:0"`
	Rank     Priority
	Avatar   []byte
	Settings datatypes.JSON
	Secret   string  `gorm:"-"`
	Orders   []Order `gorm:"constraint:OnUpdate:CASCADE,OnDelete:RESTRICT"`
}

const orderTable = "shop_orders"

type Order struct {
	ID         uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	CustomerID uint      `gorm:"not null;index:idx_order_customer_placed,priority:1"`
	Customer   Customer
	PlacedAt   time.Time `gorm:"autoCreateTime;index:idx_order_customer_placed,priority:2,sort:desc"`
	ModifiedAt int64     `gorm:"autoUpdateTime:milli"`
	Total      float64   `gorm:"precision:12;scale:2"`
	Note       string    `gorm:"type:varchar(500);comment:free text;check:length(note) < 500"`
	Items      []OrderItem
	Labels     []Label   `gorm:"many2many:order_labels;joinForeignKey:OrderRef;joinReferences:LabelRef"`
	Comments   []Comment `gorm:"polymorphic:Owner"`
}

func (*Order) TableName() string { return orderTable }

// OrderItem has a composite primary key made of a foreign key and a line number.
type OrderItem struct {
	OrderID    uuid.UUID `gorm:"type:uuid;primaryKey"`
	LineNo     int32     `gorm:"primaryKey;autoIncrement:false"`
	ProductSKU string    `gorm:"size:40;not null"`
	Quantity   uint16    `gorm:"not null;default:1"`
	Product    Product   `gorm:"foreignKey:ProductSKU;references:SKU"`
}

// Product has a string primary key and a soft-delete column.
type Product struct {
	SKU       string          `gorm:"primaryKey;size:40"`
	Title     string          `gorm:"size:200;not null;index:,class:FULLTEXT"`
	Slug      string          `gorm:"size:100;index:idx_product_slug,type:hash,where:deleted_at IS NULL"`
	Price     decimal.Decimal `gorm:"type:decimal(10,2)"`
	Stock     int32           `gorm:"column:in_stock;default:0"`
	DeletedAt gorm.DeletedAt
	Similar   []Product `gorm:"many2many:product_similar"`
}

type Label struct {
	ID   uint
	Name string `gorm:"size:40;uniqueIndex"`
}

// Comment can belong to several kinds of owner through OwnerID and OwnerType.
type Comment struct {
	ID        uint
	Body      string `gorm:"type:text"`
	OwnerID   uint
	OwnerType string `gorm:"size:30"`
}

// CustomerFilter is an API type: no gorm tag and no ID field, so it is not a model.
type CustomerFilter struct {
	Email string
	Since time.Time
}
