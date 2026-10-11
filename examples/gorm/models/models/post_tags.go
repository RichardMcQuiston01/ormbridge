package models

// PostTags maps to the "blog_post_tags" table.
type PostTags struct {
	ID     int32 `gorm:"primaryKey;autoIncrement"`
	PostID int32 `gorm:"not null;uniqueIndex:uni_blog_post_tags_post_id_tag_id,priority:1"`
	TagID  int32 `gorm:"not null;uniqueIndex:uni_blog_post_tags_post_id_tag_id,priority:2"`

	Post Post `gorm:"foreignKey:PostID;constraint:OnDelete:CASCADE"`
	Tag  Tag  `gorm:"foreignKey:TagID;constraint:OnDelete:CASCADE"`
}

// TableName overrides GORM's default table name (post_tags).
func (PostTags) TableName() string {
	return "blog_post_tags"
}
