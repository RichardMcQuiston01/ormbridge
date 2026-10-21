package models

import "time"

// PostTags maps to the "post_tags" table.
type PostTags struct {
	ID        int32     `gorm:"primaryKey;autoIncrement:false"`
	PostID    int32     `gorm:"not null"`
	TagID     int32     `gorm:"not null"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`
}
