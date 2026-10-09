package models

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"gorm.io/datatypes"
)

// Post maps to the "blog_post" table.
type Post struct {
	CreatedAt   time.Time        `gorm:"not null;autoCreateTime"`
	UpdatedAt   time.Time        `gorm:"not null;autoUpdateTime"`
	ID          int32            `gorm:"primaryKey;autoIncrement"`
	PublicID    uuid.UUID        `gorm:"type:uuid;not null;unique;default:gen_random_uuid()"`
	Title       string           `gorm:"size:200;not null;uniqueIndex:uni_blog_post_author_id_title,priority:2;index"`
	Body        string           `gorm:"type:text;not null"`
	Status      PostStatus       `gorm:"not null;default:draft;index:post_pub_status_idx,priority:2"`
	Rating      *decimal.Decimal `gorm:"type:decimal(4,2)"`
	ViewCount   int32            `gorm:"not null;default:0"`
	IsFeatured  bool             `gorm:"not null;default:false"`
	PublishedAt time.Time        `gorm:"not null;autoCreateTime;index:post_pub_status_idx,priority:1"`
	Metadata    datatypes.JSON   `gorm:"not null;default:'{}'"`
	AuthorID    int32            `gorm:"not null;uniqueIndex:uni_blog_post_author_id_title,priority:1"`
	EditorID    *int32
	CategoryID  int32 `gorm:"not null"`

	Author   User     `gorm:"foreignKey:AuthorID;constraint:OnDelete:CASCADE"`
	Editor   *User    `gorm:"foreignKey:EditorID;constraint:OnDelete:SET NULL"`
	Category Category `gorm:"foreignKey:CategoryID;constraint:OnDelete:RESTRICT"`
	Tags     []Tag    `gorm:"many2many:blog_post_tags;constraint:OnDelete:CASCADE"`
}

// TableName overrides GORM's default table name (posts).
func (Post) TableName() string {
	return "blog_post"
}
