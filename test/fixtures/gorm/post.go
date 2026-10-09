package models

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"gorm.io/datatypes"
)

type Post struct {
	TimeStamped
	ID          int32            `gorm:"primaryKey"`
	PublicID    uuid.UUID        `gorm:"column:public_id;type:uuid;unique;default:gen_random_uuid()"`
	Title       string           `gorm:"size:200;not null;index;uniqueIndex:uniq_post_author_title,priority:2"`
	Body        string           `gorm:"type:text;not null"`
	Status      PostStatus       `gorm:"not null;default:draft;index:post_pub_status_idx,priority:2"`
	Rating      *decimal.Decimal `gorm:"type:numeric(4,2)"`
	ViewCount   int32            `gorm:"not null;default:0"`
	IsFeatured  bool             `gorm:"not null;default:false"`
	PublishedAt time.Time        `gorm:"not null;default:now();index:post_pub_status_idx,priority:1"`
	Metadata    datatypes.JSON   `gorm:"not null;default:'{}'"`
	AuthorID    int32            `gorm:"not null;uniqueIndex:uniq_post_author_title,priority:1"`
	Author      User             `gorm:"foreignKey:AuthorID"`
	EditorID    *int32
	Editor      *User    `gorm:"foreignKey:EditorID"`
	CategoryID  int32    `gorm:"not null"`
	Category    Category `gorm:"constraint:OnDelete:RESTRICT"`
	Tags        []Tag    `gorm:"many2many:blog_post_tags"`
}

func (Post) TableName() string { return "blog_post" }
