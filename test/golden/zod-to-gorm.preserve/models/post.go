package models

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"gorm.io/datatypes"
)

// Post maps to the "Post" table.
type Post struct {
	ID          int32            `gorm:"primaryKey;autoIncrement:false"`
	CreatedAt   time.Time        `gorm:"not null;autoCreateTime"`
	UpdatedAt   time.Time        `gorm:"not null"`
	PublicID    uuid.UUID        `gorm:"type:uuid;not null"`
	Title       string           `gorm:"size:200;not null"`
	Body        string           `gorm:"type:text;not null"`
	Status      PostStatus       `gorm:"not null;default:draft"`
	Rating      *decimal.Decimal `gorm:"type:decimal(4,2)"`
	ViewCount   int32            `gorm:"not null;default:0"`
	IsFeatured  bool             `gorm:"not null;default:false"`
	PublishedAt time.Time        `gorm:"not null;autoCreateTime"`
	Metadata    datatypes.JSON   `gorm:"not null;default:'{}'"`
	AuthorID    int32            `gorm:"not null"`
	EditorID    *int32
	CategoryID  int32 `gorm:"not null"`
}

// TableName overrides GORM's default table name (posts).
func (Post) TableName() string {
	return "Post"
}
