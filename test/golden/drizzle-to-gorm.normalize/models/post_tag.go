package models

import "time"

// PostTag maps to the "post_tags" table.
type PostTag struct {
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`
	PostID    int32     `gorm:"primaryKey"`
	TagID     int32     `gorm:"primaryKey"`

	Post Post `gorm:"foreignKey:PostID;constraint:OnDelete:CASCADE"`
	Tag  Tag  `gorm:"foreignKey:TagID;constraint:OnDelete:CASCADE"`
}
