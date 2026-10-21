package models

// PostTags maps to the "PostTags" table.
type PostTags struct {
	ID     int32 `gorm:"primaryKey;autoIncrement:false"`
	PostID int32 `gorm:"not null"`
	TagID  int32 `gorm:"not null"`
}

// TableName overrides GORM's default table name (post_tags).
func (PostTags) TableName() string {
	return "PostTags"
}
