package models

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"gorm.io/datatypes"
)

// BlogPost maps to the "blog_posts" table.
type BlogPost struct {
	ID          int32            `gorm:"primaryKey;autoIncrement"`
	CreatedAt   time.Time        `gorm:"not null;autoCreateTime"`
	UpdatedAt   time.Time        `gorm:"not null"`
	PublicID    uuid.UUID        `gorm:"type:uuid;not null;unique;default:gen_random_uuid()"`
	Title       string           `gorm:"size:200;not null;uniqueIndex:blog_post_author_id_title_key,priority:2;index:blog_post_title_idx"`
	Body        string           `gorm:"type:text;not null"`
	Status      PostStatus       `gorm:"not null;default:draft;index:post_pub_status_idx,priority:2"`
	Rating      *decimal.Decimal `gorm:"type:decimal(4,2)"`
	ViewCount   int32            `gorm:"not null;default:0"`
	IsFeatured  bool             `gorm:"not null;default:false"`
	PublishedAt time.Time        `gorm:"not null;autoCreateTime;index:post_pub_status_idx,priority:1"`
	Metadata    datatypes.JSON   `gorm:"not null;default:'{}'"`
	AuthorID    int32            `gorm:"not null;uniqueIndex:blog_post_author_id_title_key,priority:1"`
	EditorID    *int32
	CategoryID  int32 `gorm:"not null"`

	Author   BlogUser     `gorm:"foreignKey:AuthorID;constraint:OnDelete:CASCADE"`
	Editor   *BlogUser    `gorm:"foreignKey:EditorID;constraint:OnDelete:SET NULL"`
	Category BlogCategory `gorm:"foreignKey:CategoryID;constraint:blog_post_category_id_fkey,OnDelete:RESTRICT"`
	Tags     []BlogTag    `gorm:"many2many:blog_posts_tags;constraint:OnDelete:CASCADE"`
}
