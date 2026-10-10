package models

import "time"

// BlogTag maps to the "blog_tags" table.
type BlogTag struct {
	ID        int32     `gorm:"primaryKey;autoIncrement"`
	Label     string    `gorm:"size:50;not null"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`

	BlogPosts []BlogPost `gorm:"many2many:blog_posts_tags;constraint:OnDelete:CASCADE"`
}
