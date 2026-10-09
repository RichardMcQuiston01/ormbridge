package models

// PostTag maps to the "blog_post_tags" table.
type PostTag struct {
	PostID int32 `gorm:"primaryKey"`
	TagID  int32 `gorm:"primaryKey"`

	Post Post `gorm:"foreignKey:PostID;constraint:OnDelete:CASCADE"`
	Tag  Tag  `gorm:"foreignKey:TagID;constraint:OnDelete:CASCADE"`
}

// TableName overrides GORM's default table name (post_tags).
func (PostTag) TableName() string {
	return "blog_post_tags"
}
