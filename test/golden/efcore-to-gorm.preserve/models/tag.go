package models

// Tag maps to the "blog_tag" table.
type Tag struct {
	ID    int32  `gorm:"column:Id;primaryKey;autoIncrement"`
	Label string `gorm:"column:Label;size:50;not null"`

	Posts []Post `gorm:"many2many:blog_post_tags;constraint:OnDelete:CASCADE"`
}

// TableName overrides GORM's default table name (tags).
func (Tag) TableName() string {
	return "blog_tag"
}
