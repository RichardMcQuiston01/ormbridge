package models

// BlogTag maps to the "blog_tag" table.
type BlogTag struct {
	ID    int32  `gorm:"primaryKey;autoIncrement"`
	Label string `gorm:"size:50;not null"`

	BlogPosts []BlogPost `gorm:"many2many:blog_post_tags;constraint:OnDelete:CASCADE"`
}

// TableName overrides GORM's default table name (blog_tags).
func (BlogTag) TableName() string {
	return "blog_tag"
}
