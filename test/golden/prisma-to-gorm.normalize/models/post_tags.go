package models

import "time"

// PostTags maps to the "post_tags" table.
type PostTags struct {
	ID        int32     `gorm:"primaryKey;autoIncrement"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`
	PostID    int32     `gorm:"not null;uniqueIndex:uni_post_tags_post_id_tag_id,priority:1"`
	TagID     int32     `gorm:"not null;uniqueIndex:uni_post_tags_post_id_tag_id,priority:2"`

	Post Post `gorm:"foreignKey:PostID;constraint:OnDelete:CASCADE"`
	Tag  Tag  `gorm:"foreignKey:TagID;constraint:OnDelete:CASCADE"`
}
